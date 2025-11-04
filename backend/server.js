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
          const instructions = parts[1].match(/I\d+/g) || [];
          currentCycle.stages[stage] = instructions;
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
    }
    
    if (inTimelineBlock && line.match(/I\d+\s+\|/)) {
      const parts = line.split('|').map(p => p.trim());
      if (parts.length >= 4) {
        timeline.push({
          id: parts[0],
          issueCycle: parseInt(parts[1]) || -1,
          completeCycle: parseInt(parts[2]) || -1,
          totalCycles: parseInt(parts[3]) || 0
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
    
    if (!instructions || !Array.isArray(instructions)) {
      return res.status(400).json({ error: 'Invalid instructions format' });
    }
    
    const simId = generateSimId();
    const tempFile = path.join(__dirname, `instructions_${simId}.txt`);
    
    // Write instructions to temporary file
    const instructionText = instructions.join('\n');
    await fs.writeFile(tempFile, instructionText);
    
    // Binary should already be compiled at startup
    // Just verify it exists
    try {
      await fs.access('./pipeline', fs.constants.X_OK);
    } catch (err) {
      console.error('❌ Pipeline binary not found! Server may not have initialized properly.');
      return res.status(500).json({ 
        error: 'Pipeline binary not available', 
        message: 'Server initialization issue. Please contact administrator.' 
      });
    }
    
    // Run simulation
    const { stdout, stderr } = await execPromise(`./pipeline ${tempFile}`);
    
    // Clean up temp file
    await fs.unlink(tempFile);
    
    // Parse output
    const result = parseSimulationOutput(stdout);
    
    // Cache result
    simulationCache.set(simId, result);
    
    res.json({
      simId,
      success: true,
      result
    });
    
  } catch (error) {
    console.error('Simulation error:', error);
    res.status(500).json({ 
      error: 'Simulation failed', 
      message: error.message 
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
  
  for (let i = 0; i < count; i++) {
    const op = ops[Math.floor(Math.random() * ops.length)];
    const r1 = Math.floor(Math.random() * 16);
    const r2 = Math.floor(Math.random() * 16);
    const r3 = Math.floor(Math.random() * 16);
    
    if (op === 'LOAD' || op === 'STORE') {
      instructions.push(`${op} R${r1} R${r2}`);
    } else {
      instructions.push(`${op} R${r1} R${r2} R${r3}`);
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
    return res.status(404).json({ error: 'Simulation not found' });
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
  
  try {
    // Check if pipeline.cpp exists
    await fs.access('pipeline.cpp');
    console.log('✅ Found pipeline.cpp');
  } catch {
    console.error('❌ ERROR: pipeline.cpp not found!');
    process.exit(1);
  }
  
  try {
    // Check if binary already exists
    await fs.access('./pipeline', fs.constants.X_OK);
    console.log('✅ Pipeline binary already compiled and executable');
  } catch {
    console.log('⚙️  Compiling pipeline.cpp...');
    try {
      const { stdout, stderr } = await execPromise('g++ -fopenmp pipeline.cpp -o pipeline');
      if (stderr && !stderr.includes('warning')) {
        console.error('⚠️  Compilation warnings:', stderr);
      }
      
      // Verify compilation succeeded
      await fs.access('./pipeline', fs.constants.X_OK);
      console.log('✅ Compilation successful!');
    } catch (err) {
      console.error('❌ COMPILATION FAILED:', err.message);
      console.error('   Make sure g++ is installed: apt-get install g++');
      process.exit(1);
    }
  }
  
  // Test the binary
  try {
    console.log('🧪 Testing pipeline binary...');
    // Create a minimal test file
    await fs.writeFile('test_startup.txt', 'ADD R1 R2 R3');
    const { stdout } = await execPromise('./pipeline test_startup.txt');
    await fs.unlink('test_startup.txt');
    
    if (stdout.includes('PERFORMANCE STATISTICS') || stdout.includes('PIPELINE')) {
      console.log('✅ Pipeline binary works correctly!');
    } else {
      console.warn('⚠️  Binary output looks unexpected');
    }
  } catch (err) {
    console.error('⚠️  Binary test failed (may be normal):', err.message);
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
    console.log(`   GET  /api/simulation/:simId - Get cached results`);
    console.log(`   GET  /health - Health check`);
  });
}).catch(err => {
  console.error('💥 Server initialization failed:', err);
  process.exit(1);
});

module.exports = app;