const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const port = 3001;

// Setup for file uploads
const upload = multer({ dest: os.tmpdir() });

app.use(cors()); // Allow requests from your React app
app.use(express.json()); // Parse JSON bodies

// --- Endpoint to Generate Instructions ---
app.post('/api/generate-instructions', (req, res) => {
  const { count = 10 } = req.body;
  
  // In a real app, you might run a Python script here
  // For now, we'll return a hard-coded list with hazards
  const sampleInstructions = [
    "LOAD R1 R0",      // R1 = mem[R0]
    "ADD R2 R1 R0",    // RAW hazard on R1
    "MUL R3 R2 R1",    // RAW hazard on R2, R1
    "FADD F1 F0 F0",   // Uses FPU
    "STORE R3 R0",     // RAW hazard on R3
    "SUB R4 R4 R0",
    "DIV R5 R4 R2",    // RAW hazard on R4, R2
    "LOAD R6 R0",
    "ADD R7 R6 R0",    // RAW hazard on R6
    "ADD R8 R7 R0"     // RAW hazard on R7
  ];
  
  const instructions = sampleInstructions.slice(0, Math.min(count, sampleInstructions.length));
  
  console.log(`[LOG] Generated ${instructions.length} instructions.`);
  res.json({ instructions });
});

// --- Endpoint to Upload File ---
app.post('/api/upload-file', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const filePath = req.file.path;

  try {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const instructions = fileContent.split('\n').filter(line => 
      line.trim().length > 0 && !line.trim().startsWith('#')
    );

    fs.unlinkSync(filePath); // Clean up temp file

    console.log(`[LOG] Parsed ${instructions.length} instructions from ${req.file.originalname}.`);
    res.json({ instructions });
  
  } catch (err) {
    console.error('File processing error:', err);
    res.status(500).json({ error: 'Failed to read or parse file.' });
  }
});


// --- Endpoint to Run Simulation ---
app.post('/api/simulate', (req, res) => {
  const { instructions } = req.body;

  if (!instructions || instructions.length === 0) {
    return res.status(400).json({ error: 'No instructions provided.' });
  }

  console.log(`[LOG] Spawning C++ simulation with ${instructions.length} instructions...`);

  // Path to your compiled C++ executable
  const executablePath = './pipeline_web';
  
  // Spawn the C++ process
  const simProcess = spawn(executablePath);

  let stdoutData = '';
  let stderrData = '';

  // Handle stdout from C++
  simProcess.stdout.on('data', (data) => {
    stdoutData += data.toString();
  });

  // Handle stderr (for errors)
  simProcess.stderr.on('data', (data) => {
    stderrData += data.toString();
    console.error(`[CPP_ERR] ${data}`);
  });

  // Handle process exit
  simProcess.on('close', (code) => {
    console.log(`[LOG] C++ process exited with code ${code}`);
    
    if (code !== 0) {
      return res.status(500).json({ 
        error: 'Simulation failed.', 
        stderr: stderrData 
      });
    }

    try {
      // The C++ app's entire output is the JSON string
      const simulationResult = JSON.parse(stdoutData);
      console.log('[LOG] Simulation successful. Sending JSON to client.');
      res.json(simulationResult); // This will be { "result": { ... } }
    
    } catch (err) {
      console.error('JSON parse error:', err);
      res.status(500).json({ 
        error: 'Failed to parse simulation output.', 
        stdout: stdoutData,
        stderr: stderrData
      });
    }
  });

  // Write the instructions (as JSON) to the C++ process's stdin
  const payload = JSON.stringify({ instructions });
  simProcess.stdin.write(payload);
  simProcess.stdin.end();
});

app.listen(port, () => {
  console.log(`CPU Pipeline API Server listening at http://localhost:${port}`);
});
