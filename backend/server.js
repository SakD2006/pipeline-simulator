const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');

const execPromise = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3001;

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1024 * 1024 // 1MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/plain' || file.originalname.endsWith('.txt')) {
      cb(null, true);
    } else {
      cb(new Error('Only .txt files are allowed'));
    }
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Store simulation results temporarily
const simulationCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Generate unique ID for each simulation
function generateSimId() {
  return `sim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Parse C++ output into structured data
function parseSimulationOutput(output) {
  const lines = output.split('\n');
  const cycles = [];
  const stats = {};
  const timeline = [];
  
  let currentCycle = null;
  let inCycleBlock = false;
  let inStatsBlock = false;
  let inTimelineBlock = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Parse cycle information
    if (line.includes('CYCLE')) {
      const match = line.match(/CYCLE\s+(\d+)/);
      if (match) {
        if (currentCycle) cycles.push(currentCycle);
        currentCycle = {
          cycle: parseInt(match[1]),
          stages: {},
          stalls: [],
          units: {}
        };
        inCycleBlock = true;
      }
    }
    
    // Parse stage information
    if (inCycleBlock && currentCycle) {
      if (line.includes('FETCH:') || line.includes('DECODE:') || 
          line.includes('ISSUE:') || line.includes('EXECUTE:') || 
          line.includes('WRITEBACK:')) {
        const parts = line.split(':');
        if (parts.length >= 2) {
          const stage = parts[0].trim().replace('│', '').trim();
          // Find all instruction IDs (e.g., I12, I3)
          const instructions = parts[1].match(/I\d+/g) || [];
          // Find all stalled instructions (e.g., I4⚠)
          const stalled = parts[1].match(/I\d+⚠/g) || [];
          
          const allInstructions = [...instructions, ...stalled.map(s => s.replace('⚠', ''))];
          // Use a Set to remove duplicates if any, then convert back to array
          currentCycle.stages[stage] = [...new Set(allInstructions)];
        }
      }
      
      // Parse stalls
      if (line.includes('STALLED:')) {
        const stallMatch = line.match(/I(\d+)\s+STALLED:\s+(.+)/);
        if (stallMatch) {
          currentCycle.stalls.push({
            instruction: `I${stallMatch[1]}`,
            reason: stallMatch[2].trim()
          });
        }
      }
      
      // Parse execution units
      if (line.includes('Units:')) {
        const unitMatches = line.matchAll(/(\w+)\((\d+)\/(\d+)\)/g);
        for (const match of unitMatches) {
          currentCycle.units[match[1]] = {
            available: parseInt(match[2]),
            total: parseInt(match[3])
          };
        }
      }
      
      if (line.includes('└─') || line.includes('┘')) {
        inCycleBlock = false;
      }
    }
    
    // Parse statistics
    if (line.includes('PERFORMANCE STATISTICS')) {
      inStatsBlock = true;
    }
    
    if (inStatsBlock) {
      const statPatterns = [
        { key: 'totalCycles', pattern: /Total Cycles:\s+(\d+)/ },
        { key: 'instructionsCompleted', pattern: /Instructions Completed:\s+(\d+)/ },
        { key: 'ipc', pattern: /Instructions Per Cycle:\s+([\d.]+)/ },
        { key: 'totalStalls', pattern: /Total Stall Cycles:\s+(\d+)/ },
        { key: 'rawHazards', pattern: /RAW Hazards:\s+(\d+)/ },
        { key: 'warHazards', pattern: /WAR Hazards:\s+(\d+)/ },
        { key: 'wawHazards', pattern: /WAW Hazards:\s+(\d+)/ },
        { key: 'structuralHazards', pattern: /Structural Hazards:\s+(\d+)/ },
        { key: 'branchMispredictions', pattern: /Branch Mispredictions:\s+(\d+)/ }
      ];
      
      for (const { key, pattern } of statPatterns) {
        const match = line.match(pattern);
        if (match) {
          stats[key] = key === 'ipc' ? parseFloat(match[1]) : parseInt(match[1]);
        }
      }
      
      if (line.includes('╚═') || line.includes('┘')) {
        inStatsBlock = false;
      }
    }
    
    // Parse timeline
    if (line.includes('Instruction Timeline:')) {
      inTimelineBlock = true;
      // Skip the header row
      i++; 
      continue;
    }
    
    if (inTimelineBlock && line.match(/I\d+\s+\|/)) {
      const parts = line.split('|').map(p => p.trim());
      
      // *** CRITICAL FIX HERE ***
      // We expect 5 columns: ID | Opcode | Issue | Complete | Total Cycles
      if (parts.length >= 5) {
        timeline.push({
          id: parts[0],
          opcode: parts[1],
          issueCycle: parseInt(parts[2]) || -1,
          completeCycle: parseInt(parts[3]) || -1,
          totalCycles: parseInt(parts[4]) || 0
        });
      }
    }
  }
  
  if (currentCycle) cycles.push(currentCycle);
  
  return { cycles, stats, timeline };
}

// Endpoint: Run simulation
app.post('/api/simulate', async (req, res) => {
  try {
    const { instructions } = req.body;
    
    if (!instructions || !Array.isArray(instructions) || instructions.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty instructions format' });
    }
    
    const simId = generateSimId();
    // Use OS's temporary directory for robustness
    const tempDir = require('os').tmpdir();
    const tempFile = path.join(tempDir, `instructions_${simId}.txt`);
    
    // Write instructions to temporary file
    const instructionText = instructions.join('\n');
    await fs.writeFile(tempFile, instructionText);
    
    // Determine binary path
    const binaryPath = path.resolve(__dirname, 'pipeline');
    
    // Verify binary exists and is executable
    try {
      await fs.access(binaryPath, fs.constants.X_OK);
    } catch (err) {
      console.error('❌ Pipeline binary not found or not executable! Server may not have initialized properly.');
      return res.status(500).json({ 
        error: 'Pipeline binary not available', 
        message: 'Server initialization issue. Please contact administrator.' 
      });
    }
    
    // Run simulation
    // Enclose tempFile in quotes to handle paths with spaces
    const { stdout, stderr } = await execPromise(`"${binaryPath}" "${tempFile}"`);
    
    // Clean up temp file
    try {
      await fs.unlink(tempFile);
    } catch (unlinkErr) {
      console.warn(`⚠️  Could not delete temp file: ${tempFile}`, unlinkErr.message);
    }

    if (stderr) {
      console.warn(`Simulation STDERR for ${simId}:`, stderr);
    }
    
    // Parse output
    const result = parseSimulationOutput(stdout);
    
    // Cache result
    simulationCache.set(simId, result);
    
    // *** SUGGESTION FIX HERE ***
    // Set a timer to automatically delete the cache entry after TTL
    setTimeout(() => {
      simulationCache.delete(simId);
      console.log(`Cache expired and deleted for ${simId}`);
    }, CACHE_TTL_MS);
    
    res.json({
      simId,
      success: true,
      result
    });
    
  } catch (error) {
    console.error(`❌ Simulation error for ${simId || 'N/A'}:`, error);
    res.status(500).json({ 
      error: 'Simulation failed', 
      message: error.message,
      stdout: error.stdout,
      stderr: error.stderr
    });
  }
});

// Endpoint: Generate sample instructions
app.post('/api/generate-instructions', (req, res) => {
  const { count = 10, complexity = 'medium' } = req.body;
  
  const opcodes = {
    simple: ['ADD', 'SUB', 'LOAD', 'STORE'],
    medium: ['ADD', 'SUB', 'MUL', 'LOAD', 'STORE', 'FADD'],
    complex: ['ADD', 'SUB', 'MUL', 'DIV', 'FADD', 'FMUL', 'FDIV', 'LOAD', 'STORE']
  };
  
  const ops = opcodes[complexity] || opcodes.medium;
  const instructions = [];
  const maxReg = 16;
  
  // Create some potential dependencies
  let lastDestReg = -1;

  for (let i = 0; i < count; i++) {
    const op = ops[Math.floor(Math.random() * ops.length)];
    const r1_dest = Math.floor(Math.random() * maxReg);
    
    // 50% chance to create a dependency
    const r2_src1 = (lastDestReg !== -1 && Math.random() < 0.5) 
                   ? lastDestReg 
                   : Math.floor(Math.random() * maxReg);
                   
    const r3_src2 = Math.floor(Math.random() * maxReg);
    
    if (op === 'LOAD' || op === 'STORE') {
      instructions.push(`${op} R${r1_dest} R${r2_src1}`);
      lastDestReg = (op === 'LOAD') ? r1_dest : -1; // Only LOAD creates a dependency
    } else {
      instructions.push(`${op} R${r1_dest} R${r2_src1} R${r3_src2}`);
      lastDestReg = r1_dest;
    }
  }
  
  res.json({ instructions });
});

// Endpoint: Upload instruction file
app.post('/api/upload-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    console.log(`📁 File uploaded: ${req.file.originalname} (${req.file.size} bytes)`);
    
    // Parse file content
    const content = req.file.buffer.toString('utf-8');
    const lines = content.split('\n');
    const instructions = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines and comments
      if (trimmed && !trimmed.startsWith('#')) {
        instructions.push(trimmed);
      }
    }
    
    if (instructions.length === 0) {
      return res.status(400).json({ 
        error: 'No valid instructions found in file',
        hint: 'File should contain instructions like: ADD R1 R2 R3'
      });
    }
    
    console.log(`✅ Parsed ${instructions.length} instructions from file`);
    
    res.json({ 
      instructions,
      filename: req.file.originalname,
      count: instructions.length
    });
    
  } catch (error) {
    console.error('❌ File upload error:', error);
    res.status(500).json({ 
      error: 'File upload failed', 
      message: error.message 
    });
  }
});

// Endpoint: Get cached simulation
app.get('/api/simulation/:simId', (req, res) => {
  const { simId } = req.params;
  const result = simulationCache.get(simId);
  
  if (!result) {
    return res.status(404).json({ error: 'Simulation not found or has expired' });
  }
  
  res.json(result);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Compile C++ at startup
async function initializeServer() {
  console.log('🔧 Initializing server...');
  const cppFile = 'pipeline_fixed.cpp'; // Assuming this is the name
  const binaryFile = 'pipeline';
  
  try {
    // Check if pipeline_fixed.cpp exists
    await fs.access(cppFile);
    console.log(`✅ Found ${cppFile}`);
  } catch {
    console.error(`❌ ERROR: ${cppFile} not found!`);
    console.error('   Please add the C++ file to the backend directory.');
    process.exit(1);
  }
  
  try {
    // Check if binary already exists
    await fs.access(`./${binaryFile}`, fs.constants.X_OK);
    console.log(`✅ Pipeline binary already compiled and executable`);
  } catch {
    console.log(`⚙️  Compiling ${cppFile}...`);
    try {
      const { stdout, stderr } = await execPromise(`g++ -fopenmp ${cppFile} -o ${binaryFile} -O2`);
      if (stderr) {
        console.warn('⚠️  Compilation warnings/errors:', stderr);
      }
      
      // Verify compilation succeeded
      await fs.access(`./${binaryFile}`, fs.constants.X_OK);
      console.log('✅ Compilation successful!');
    } catch (err) {
      console.error('❌ COMPILATION FAILED:', err.message);
      console.error('   Make sure g++ and OpenMP are installed.');
      console.error('   (e.g., sudo apt-get install g++ libomp-dev)');
      process.exit(1);
    }
  }
  
  // Test the binary
  try {
    console.log('🧪 Testing pipeline binary...');
    // Create a minimal test file
    const testFile = path.join(require('os').tmpdir(), 'test_startup.txt');
    await fs.writeFile(testFile, 'ADD R1 R2 R3\nNOP');
    const { stdout } = await execPromise(`"./${binaryFile}" "${testFile}"`);
    await fs.unlink(testFile);
    
    if (stdout.includes('PERFORMANCE STATISTICS')) {
      console.log('✅ Pipeline binary works correctly!');
    } else {
      console.warn('⚠️  Binary output looks unexpected, check stdout:', stdout);
    }
  } catch (err) {
    console.error('⚠️  Binary test run failed:', err.message);
  }
  
  console.log('🎉 Server initialization complete!\n');
}

// Start server
initializeServer().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Pipeline Simulator Backend running on port ${PORT}`);
    console.log(`📊 API endpoints:`);
    console.log(`   POST /api/simulate - Run simulation`);
    console.log(`   POST /api/generate-instructions - Generate sample instructions`);
    console.log(`   POST /api/upload-file - Upload instruction .txt file`);
    console.log(`   GET  /api/simulation/:simId - Get cached results`);
    console.log(`   GET  /health - Health check`);
  });
}).catch(err => {
  console.error('💥 Server initialization failed:', err);
  process.exit(1);
});

module.exports = app;
