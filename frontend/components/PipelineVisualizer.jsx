'use client';
import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Pause, SkipForward, RotateCcw, Plus, Zap, 
  AlertCircle, Upload, FileText, X, Loader2 
} from 'lucide-react';

// Main Component
export default function PipelineVisualizer() {
  const [instructions, setInstructions] = useState([]);
  const [simulationData, setSimulationData] = useState(null);
  const [currentCycle, setCurrentCycle] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(null); // 'generate', 'upload', 'simulate'
  const [error, setError] = useState(null);
  const [instructionCount, setInstructionCount] = useState(10);
  const [uploadedFile, setUploadedFile] = useState(null);
  const fileInputRef = useRef(null);
  
  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

  const clearAll = () => {
    setInstructions([]);
    setSimulationData(null);
    setCurrentCycle(0);
    setIsPlaying(false);
    setError(null);
    setUploadedFile(null);
  };

  const generateInstructions = async () => {
    setLoading('generate');
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/generate-instructions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: instructionCount, complexity: 'medium' })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const data = await response.json();
      setInstructions(data.instructions);
      setSimulationData(null); // Clear old simulation
      setUploadedFile(null); // Clear file
    } catch (err) {
      setError('Failed to generate instructions: ' + err.message);
    }
    setLoading(null);
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    setLoading('upload');
    setError(null);
    
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      const response = await fetch(`${API_URL}/api/upload-file`, {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Upload failed: ${errorData.error || response.statusText}`);
      }
      
      const data = await response.json();
      setInstructions(data.instructions);
      setUploadedFile(file.name);
      setSimulationData(null); // Clear old simulation
    } catch (err) {
      setError('File upload failed: ' + err.message);
    }
    
    setLoading(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const runSimulation = async () => {
    if (instructions.length === 0) {
      setError('Please generate or upload instructions first');
      return;
    }
    
    setLoading('simulate');
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions })
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`HTTP ${response.status}: ${errorData.error || response.statusText}`);
      }
      
      const data = await response.json();
      if (!data.result || !data.result.cycles) {
        throw new Error('Invalid simulation data received');
      }
      
      setSimulationData(data.result);
      setCurrentCycle(0);
      setIsPlaying(false);
    } catch (err) {
      setError('Simulation error: ' + err.message);
    }
    setLoading(null);
  };

  useEffect(() => {
    let interval;
    if (isPlaying && simulationData && currentCycle < simulationData.cycles.length - 1) {
      interval = setInterval(() => {
        setCurrentCycle(prev => prev + 1);
      }, 800);
    } else if (isPlaying) {
      setIsPlaying(false);
    }
    return () => clearInterval(interval);
  }, [isPlaying, currentCycle, simulationData]);

  const cycleData = simulationData?.cycles[currentCycle];

  const isLoading = (action) => loading === action;

  return (
    <div className="min-h-screen bg-linear-to-br from-gray-900 via-blue-950 to-gray-900 text-white p-4 md:p-8">
      <div className="max-w-8xl mx-auto">
        
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl md:text-5xl font-bold mb-2 bg-linear-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            CPU Pipeline Simulator
          </h1>
          <p className="text-gray-400 text-sm md:text-base">5-Stage Superscalar Out-of-Order Pipeline Visualization</p>
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-6 p-4 bg-red-500/20 border border-red-500 rounded-lg flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-red-400" />
            <span className="text-red-200">{error}</span>
            <button onClick={() => setError(null)} className="ml-auto p-1 rounded-full hover:bg-red-500/30">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Main Grid Layout */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8">

          {/* --- Sidebar (Controls & Stats) --- */}
          <aside className="md:col-span-4 lg:col-span-3 space-y-6">
            <ControlPanel
              instructionCount={instructionCount}
              setInstructionCount={setInstructionCount}
              generateInstructions={generateInstructions}
              handleFileUpload={handleFileUpload}
              runSimulation={runSimulation}
              loading={loading}
              isLoading={isLoading}
              fileInputRef={fileInputRef}
              instructions={instructions}
              uploadedFile={uploadedFile}
              clearAll={clearAll}
            />

            {simulationData && (
              <>
                <PlaybackControls
                  isPlaying={isPlaying}
                  setIsPlaying={setIsPlaying}
                  currentCycle={currentCycle}
                  setCurrentCycle={setCurrentCycle}
                  simulationData={simulationData}
                />
                <StatsSummary simulationData={simulationData} />
              </>
            )}
          </aside>

          {/* --- Main Content (Visualization) --- */}
          <main className="md:col-span-8 lg:col-span-9">
            {simulationData ? (
              <div className="space-y-6">
                <PipelineStagesDisplay cycleData={cycleData} />
                {cycleData?.stalls?.length > 0 && (
                  <StallsDisplay stalls={cycleData.stalls} />
                )}
                <HazardAnalysis simulationData={simulationData} />
              </div>
            ) : (
              <WelcomePlaceholder loading={loading} />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

// --- Sub-Components ---

// Panel for Generate/Upload/Simulate
function ControlPanel({ instructionCount, setInstructionCount, generateInstructions, handleFileUpload, runSimulation, loading, isLoading, fileInputRef, instructions, uploadedFile, clearAll }) {
  return (
    <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 border border-gray-700">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Controls</h2>
        <button
          onClick={clearAll}
          title="Clear all"
          className="text-gray-400 hover:text-white transition"
        >
          <RotateCcw className="w-5 h-5" />
        </button>
      </div>

      <div className="space-y-4">
        <div className="flex gap-2">
          <input
            type="number"
            value={instructionCount}
            onChange={(e) => setInstructionCount(parseInt(e.target.value) || 10)}
            className="bg-gray-700 px-4 py-2 rounded-lg w-24 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            min="5"
            max="20"
            disabled={!!loading}
          />
          <button
            onClick={generateInstructions}
            disabled={!!loading}
            className="flex-1 bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg font-semibold transition flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isLoading('generate') ? <Loader2 className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />}
            Generate
          </button>
        </div>

        <div className="relative">
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt"
            onChange={handleFileUpload}
            className="hidden"
            id="file-upload"
            disabled={!!loading}
          />
          <label
            htmlFor="file-upload"
            className={`bg-purple-600 hover:bg-purple-700 px-6 py-2 rounded-lg font-semibold transition flex items-center justify-center gap-2 cursor-pointer w-full ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {isLoading('upload') ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
            Upload .txt
          </label>
        </div>

        <button
          onClick={runSimulation}
          disabled={!!loading || instructions.length === 0}
          className="bg-green-600 hover:bg-green-700 px-6 py-2.5 rounded-lg font-semibold transition flex items-center justify-center gap-2 disabled:opacity-50 w-full text-lg"
        >
          {isLoading('simulate') ? <Loader2 className="w-5 h-5 animate-spin" /> : <Zap className="w-5 h-5" />}
          Simulate
        </button>

        {uploadedFile && (
          <div className="p-3 bg-purple-500/10 border border-purple-500/50 rounded-lg flex items-center gap-2">
            <FileText className="w-5 h-5 text-purple-400" />
            <span className="text-sm text-purple-200 truncate">
              Loaded: <span className="font-semibold">{uploadedFile}</span>
            </span>
          </div>
        )}

        {instructions.length > 0 && (
          <div className="mt-4 p-3 bg-gray-900/50 rounded-lg">
            <p className="text-sm text-gray-400 mb-2">Loaded Instructions ({instructions.length}):</p>
            <div className="text-xs font-mono text-gray-300 max-h-32 overflow-y-auto space-y-1 pr-2">
              {instructions.map((instr, i) => (
                <div key={i}>{instr}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Panel for Play/Pause/Slider
function PlaybackControls({ isPlaying, setIsPlaying, currentCycle, setCurrentCycle, simulationData }) {
  return (
    <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 border border-gray-700">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className="bg-purple-600 hover:bg-purple-700 p-3 rounded-lg transition"
          >
            {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>
          
          <button
            onClick={() => setCurrentCycle(Math.min(currentCycle + 1, simulationData.cycles.length - 1))}
            className="bg-gray-700 hover:bg-gray-600 p-3 rounded-lg transition"
            title="Next Cycle"
          >
            <SkipForward className="w-5 h-5" />
          </button>
          
          <button
            onClick={() => setCurrentCycle(0)}
            className="bg-gray-700 hover:bg-gray-600 p-3 rounded-lg transition"
            title="Reset"
          >
            <RotateCcw className="w-5 h-5" />
          </button>
        </div>

        <div className="text-right">
          <div className="text-2xl font-bold">Cycle {simulationData?.cycles[currentCycle]?.cycle || 0}</div>
          <div className="text-sm text-gray-400">of {simulationData.cycles.length - 1}</div>
        </div>
      </div>

      <div className="mt-4">
        <input
          type="range"
          min="0"
          max={simulationData.cycles.length - 1}
          value={currentCycle}
          onChange={(e) => setCurrentCycle(parseInt(e.target.value))}
          className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer range-thumb-purple"
        />
      </div>
    </div>
  );
}

// Panel for the main pipeline stage display
function PipelineStagesDisplay({ cycleData }) {
  const stageColors = {
    FETCH: 'bg-blue-500',
    DECODE: 'bg-purple-500',
    ISSUE: 'bg-yellow-500',
    EXECUTE: 'bg-green-500',
    WRITEBACK: 'bg-red-500'
  };

  return (
    <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 border border-gray-700">
      <h2 className="text-2xl font-bold mb-6">Pipeline Stages</h2>
      <div className="space-y-4">
        {['FETCH', 'DECODE', 'ISSUE', 'EXECUTE', 'WRITEBACK'].map((stage) => (
          <div key={stage} className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className={`${stageColors[stage]} px-4 py-2 rounded-lg font-semibold w-full sm:w-32 text-center`}>
              {stage}
            </div>
            <div className="flex-1 bg-gray-700/50 rounded-lg p-3 min-h-14 flex items-center gap-2 flex-wrap">
              {cycleData?.stages[stage]?.length > 0 ? (
                cycleData.stages[stage].map((instr, i) => (
                  <div
                    key={i}
                    className={`${stageColors[stage]} px-3 py-1 rounded-md text-sm font-mono animate-pulse`}
                  >
                    {instr}
                  </div>
                ))
              ) : (
                <span className="text-gray-500 text-sm italic px-2">Empty</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Panel for Stalls
function StallsDisplay({ stalls }) {
  return (
    <div className="bg-yellow-500/10 border border-yellow-500/50 rounded-xl p-6">
      <h3 className="text-xl font-bold mb-3 text-yellow-400 flex items-center gap-2">
        <AlertCircle className="w-5 h-5" /> Pipeline Stalls
      </h3>
      <div className="space-y-2 font-mono text-sm">
        {stalls.map((stall, i) => (
          <div key={i}>
            <span className="font-bold text-white">{stall.instruction}</span>
            <span className="text-gray-400"> — {stall.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Panel for IPC, Cycles, Stalls
function StatsSummary({ simulationData }) {
  return (
    <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 border border-gray-700">
      <h2 className="text-xl font-semibold mb-4">Statistics</h2>
      <div className="space-y-4">
        <div className="bg-blue-500/20 border border-blue-500 rounded-xl p-4">
          <div className="text-sm text-blue-300 mb-1">Total Cycles</div>
          <div className="text-3xl font-bold">{simulationData.stats.totalCycles}</div>
        </div>
        
        <div className="bg-green-500/20 border border-green-500 rounded-xl p-4">
          <div className="text-sm text-green-300 mb-1">Instructions Per Cycle</div>
          <div className="text-3xl font-bold">{simulationData.stats.ipc?.toFixed(3)}</div>
        </div>
        
        <div className="bg-red-500/20 border border-red-500 rounded-xl p-4">
          <div className="text-sm text-red-300 mb-1">Total Stalls</div>
          <div className="text-3xl font-bold">{simulationData.stats.totalStalls}</div>
        </div>
      </div>
    </div>
  );
}

// Panel for Hazard Analysis
function HazardAnalysis({ simulationData }) {
  const hazardStats = [
    { name: 'RAW Hazards', value: simulationData.stats.rawHazards, color: 'text-red-400', title: 'Read-After-Write: An instruction tries to read a register before a previous instruction has finished writing to it.' },
    { name: 'WAR Hazards', value: simulationData.stats.warHazards, color: 'text-yellow-400', title: 'Write-After-Read: An instruction tries to write to a register before a previous instruction has finished reading from it.' },
    { name: 'WAW Hazards', value: simulationData.stats.wawHazards, color: 'text-orange-400', title: 'Write-After-Write: An instruction tries to write to a register before a previous instruction has finished writing to it.' },
    { name: 'Structural', value: simulationData.stats.structuralHazards, color: 'text-purple-400', title: 'Structural Hazard: Two instructions need to use the same hardware resource (e.g., ALU, memory port) at the same time.' },
  ];

  return (
    <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 border border-gray-700">
      <h3 className="text-xl font-bold mb-4">Hazard Analysis</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {hazardStats.map((stat) => (
          <div key={stat.name} className="text-center bg-gray-900/50 p-4 rounded-lg" title={stat.title}>
            <div className={`text-3xl font-bold ${stat.color}`}>{stat.value}</div>
            <div className="text-sm text-gray-400">{stat.name}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Placeholder for when no simulation is loaded
function WelcomePlaceholder({ loading }) {
  return (
    <div className="flex items-center justify-center h-full min-h-[300px] md:min-h-[500px] bg-gray-800/30 backdrop-blur-sm rounded-xl p-6 border border-dashed border-gray-700">
      <div className="text-center text-gray-400">
        {loading ? (
          <>
            <Loader2 className="w-16 h-16 mx-auto mb-4 animate-spin text-blue-500" />
            <p className="text-lg">Processing Simulation...</p>
          </>
        ) : (
          <>
            <Zap className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <p className="text-lg">Generate or upload instructions</p>
            <p className="text-lg">Then click <span className="text-green-500 font-semibold">Simulate</span> to begin</p>
          </>
        )}
      </div>
    </div>
  );
}