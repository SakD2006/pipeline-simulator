'use client';
import React, { useState, useEffect } from 'react';
import { Play, Pause, SkipForward, RotateCcw, Plus, Zap, AlertCircle } from 'lucide-react';

export default function PipelineVisualizer() {
  const [instructions, setInstructions] = useState([]);
  const [simulationData, setSimulationData] = useState(null);
  const [currentCycle, setCurrentCycle] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [instructionCount, setInstructionCount] = useState(10);
  
  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

  const generateInstructions = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/generate-instructions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: instructionCount, complexity: 'medium' })
      });
      const data = await response.json();
      setInstructions(data.instructions);
    } catch (err) {
      setError('Failed to generate instructions: ' + err.message);
    }
    setLoading(false);
  };

  const runSimulation = async () => {
    if (instructions.length === 0) {
      setError('Please generate instructions first');
      return;
    }
    
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions })
      });
      
      if (!response.ok) throw new Error('Simulation failed');
      
      const data = await response.json();
      setSimulationData(data.result);
      setCurrentCycle(0);
    } catch (err) {
      setError('Simulation error: ' + err.message);
    }
    setLoading(false);
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

  const stageColors = {
    FETCH: 'bg-blue-500',
    DECODE: 'bg-purple-500',
    ISSUE: 'bg-yellow-500',
    EXECUTE: 'bg-green-500',
    WRITEBACK: 'bg-red-500'
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-gray-900 via-blue-900 to-gray-900 text-white p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold mb-2 bg-linear-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            CPU Pipeline Simulator
          </h1>
          <p className="text-gray-400">5-Stage Superscalar Out-of-Order Pipeline Visualization</p>
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-6 p-4 bg-red-500/20 border border-red-500 rounded-lg flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-red-400" />
            <span className="text-red-200">{error}</span>
          </div>
        )}

        {/* Control Panel */}
        <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 mb-6 border border-gray-700">
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block text-sm text-gray-400 mb-2">Instructions</label>
              <input
                type="number"
                value={instructionCount}
                onChange={(e) => setInstructionCount(parseInt(e.target.value) || 10)}
                className="bg-gray-700 px-4 py-2 rounded-lg w-24"
                min="5"
                max="20"
              />
            </div>
            
            <button
              onClick={generateInstructions}
              disabled={loading}
              className="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded-lg font-semibold transition flex items-center gap-2 disabled:opacity-50"
            >
              <Plus className="w-5 h-5" />
              Generate
            </button>

            <button
              onClick={runSimulation}
              disabled={loading || instructions.length === 0}
              className="bg-green-600 hover:bg-green-700 px-6 py-2 rounded-lg font-semibold transition flex items-center gap-2 disabled:opacity-50"
            >
              <Zap className="w-5 h-5" />
              Simulate
            </button>
          </div>

          {instructions.length > 0 && (
            <div className="mt-4 p-3 bg-gray-900/50 rounded-lg">
              <p className="text-sm text-gray-400 mb-2">Loaded Instructions ({instructions.length}):</p>
              <div className="text-xs font-mono text-gray-300 max-h-32 overflow-y-auto">
                {instructions.slice(0, 5).map((instr, i) => (
                  <div key={i}>{instr}</div>
                ))}
                {instructions.length > 5 && <div className="text-gray-500">... and {instructions.length - 5} more</div>}
              </div>
            </div>
          )}
        </div>

        {simulationData && (
          <>
            {/* Playback Controls */}
            <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 mb-6 border border-gray-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => setIsPlaying(!isPlaying)}
                    className="bg-purple-600 hover:bg-purple-700 p-3 rounded-lg transition"
                  >
                    {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                  </button>
                  
                  <button
                    onClick={() => setCurrentCycle(Math.min(currentCycle + 1, simulationData.cycles.length - 1))}
                    className="bg-gray-700 hover:bg-gray-600 p-3 rounded-lg transition"
                  >
                    <SkipForward className="w-5 h-5" />
                  </button>
                  
                  <button
                    onClick={() => setCurrentCycle(0)}
                    className="bg-gray-700 hover:bg-gray-600 p-3 rounded-lg transition"
                  >
                    <RotateCcw className="w-5 h-5" />
                  </button>
                </div>

                <div className="text-right">
                  <div className="text-2xl font-bold">Cycle {cycleData?.cycle || 0}</div>
                  <div className="text-sm text-gray-400">of {simulationData.cycles.length}</div>
                </div>
              </div>

              <div className="mt-4">
                <input
                  type="range"
                  min="0"
                  max={simulationData.cycles.length - 1}
                  value={currentCycle}
                  onChange={(e) => setCurrentCycle(parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>

            {/* Pipeline Stages */}
            <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 mb-6 border border-gray-700">
              <h2 className="text-2xl font-bold mb-4">Pipeline Stages</h2>
              <div className="space-y-3">
                {['FETCH', 'DECODE', 'ISSUE', 'EXECUTE', 'WRITEBACK'].map((stage) => (
                  <div key={stage} className="flex items-center gap-4">
                    <div className={`${stageColors[stage]} px-4 py-2 rounded-lg font-semibold w-32 text-center`}>
                      {stage}
                    </div>
                    <div className="flex-1 bg-gray-700/50 rounded-lg p-3 min-h-12 flex items-center gap-2">
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
                        <span className="text-gray-500 text-sm">Empty</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Stalls */}
            {cycleData?.stalls?.length > 0 && (
              <div className="bg-yellow-500/10 border border-yellow-500/50 rounded-xl p-6 mb-6">
                <h3 className="text-xl font-bold mb-3 text-yellow-400">⚠️ Pipeline Stalls</h3>
                <div className="space-y-2">
                  {cycleData.stalls.map((stall, i) => (
                    <div key={i} className="text-sm">
                      <span className="font-mono font-bold">{stall.instruction}</span>
                      <span className="text-gray-400"> — {stall.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Statistics */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
              <div className="bg-blue-500/20 border border-blue-500 rounded-xl p-6">
                <div className="text-sm text-gray-400 mb-1">Total Cycles</div>
                <div className="text-3xl font-bold">{simulationData.stats.totalCycles}</div>
              </div>
              
              <div className="bg-green-500/20 border border-green-500 rounded-xl p-6">
                <div className="text-sm text-gray-400 mb-1">Instructions Per Cycle</div>
                <div className="text-3xl font-bold">{simulationData.stats.ipc?.toFixed(3)}</div>
              </div>
              
              <div className="bg-red-500/20 border border-red-500 rounded-xl p-6">
                <div className="text-sm text-gray-400 mb-1">Total Stalls</div>
                <div className="text-3xl font-bold">{simulationData.stats.totalStalls}</div>
              </div>
            </div>

            {/* Hazard Stats */}
            <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 border border-gray-700">
              <h3 className="text-xl font-bold mb-4">Hazard Analysis</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center">
                  <div className="text-2xl font-bold text-red-400">{simulationData.stats.rawHazards}</div>
                  <div className="text-sm text-gray-400">RAW Hazards</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-yellow-400">{simulationData.stats.warHazards}</div>
                  <div className="text-sm text-gray-400">WAR Hazards</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-orange-400">{simulationData.stats.wawHazards}</div>
                  <div className="text-sm text-gray-400">WAW Hazards</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-purple-400">{simulationData.stats.structuralHazards}</div>
                  <div className="text-sm text-gray-400">Structural</div>
                </div>
              </div>
            </div>
          </>
        )}

        {!simulationData && !loading && (
          <div className="text-center py-20 text-gray-400">
            <Zap className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <p className="text-lg">Generate instructions and run simulation to begin</p>
          </div>
        )}

        {loading && (
          <div className="text-center py-20">
            <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-500 mx-auto"></div>
            <p className="mt-4 text-gray-400">Processing...</p>
          </div>
        )}
      </div>
    </div>
  );
}