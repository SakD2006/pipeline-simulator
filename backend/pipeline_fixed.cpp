/*
 * Advanced Parallel Instruction Pipeline Simulator (WEB API VERSION)
 *
 * This version is modified to output a single JSON object containing
 * the complete simulation results for a web API.
 *
 * It removes all intermediate console output (`cout`, `displayPipeline`).
 *
 * Requires the nlohmann/json library:
 * Download `json.hpp` from https://github.com/nlohmann/json
 *
 * Compile: g++ -std=c++17 -fopenmp pipeline_web.cpp -o pipeline_web
 */

#include <iostream>
#include <vector>
#include <string>
#include <iomanip>
#include <queue>
#include <map>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>
#include <omp.h>
#include "json.hpp" // Include the nlohmann/json header

using namespace std;
using json = nlohmann::json;

// --- (All your enums and helper functions: Opcode, ExecUnit, getExecUnit, etc.) ---
// --- (These are unchanged from your original file) ---

enum Opcode { ADD, SUB, MUL, DIV, FADD, FMUL, FDIV, LOAD, STORE, BEQ, BNE, JMP, NOP };
enum ExecUnit { ALU_UNIT, FPU_UNIT, MEM_UNIT, BRANCH_UNIT, ANY_UNIT };

ExecUnit getExecUnit(Opcode op) {
    switch(op) {
        case ADD: case SUB: case MUL: case DIV: return ALU_UNIT;
        case FADD: case FMUL: case FDIV: return FPU_UNIT;
        case LOAD: case STORE: return MEM_UNIT;
        case BEQ: case BNE: case JMP: return BRANCH_UNIT;
        default: return ANY_UNIT;
    }
}
int getLatency(Opcode op) {
    switch(op) {
        case ADD: case SUB: return 1;
        case MUL: return 3;
        case DIV: return 8;
        case FADD: return 4;
        case FMUL: return 5;
        case FDIV: return 12;
        case LOAD: return 3;
        case STORE: return 2;
        case BEQ: case BNE: case JMP: return 1;
        default: return 1;
    }
}
string opcodeToString(Opcode op) {
    const char* names[] = {"ADD", "SUB", "MUL", "DIV", "FADD", "FMUL",
                           "FDIV", "LOAD", "STORE", "BEQ", "BNE", "JMP", "NOP"};
    return (op <= NOP) ? names[op] : "UNKNOWN";
}
Opcode stringToOpcode(const string& str) {
    if (str == "ADD") return ADD;
    if (str == "SUB") return SUB;
    if (str == "MUL") return MUL;
    if (str == "DIV") return DIV;
    if (str == "FADD") return FADD;
    if (str == "FMUL") return FMUL;
    if (str == "FDIV") return FDIV;
    if (str == "LOAD") return LOAD;
    if (str == "STORE") return STORE;
    if (str == "BEQ") return BEQ;
    if (str == "BNE") return BNE;
    if (str == "JMP") return JMP;
    return NOP;
}
string unitToString(ExecUnit u) {
    const char* names[] = {"ALU", "FPU", "MEM", "BRANCH", "ANY"};
    return (u <= ANY_UNIT) ? names[u] : "UNKNOWN";
}
int parseRegister(const string& reg_str) {
    if (reg_str.empty() || reg_str[0] != 'R') return -1;
    try {
        return stoi(reg_str.substr(1));
    } catch (...) {
        return -1;
    }
}

// --- (Instruction, Stage, PipelineState structs are unchanged) ---
struct Instruction {
    int id;
    Opcode opcode;
    int src1, src2, dest;
    bool is_branch;
    int branch_target;
    string original_string; // Store the original instruction string

    Instruction(int _id, Opcode _op, int _s1, int _s2, int _d,
                const string& _orig, bool _br = false, int _bt = 0)
        : id(_id), opcode(_op), src1(_s1), src2(_s2), dest(_d),
          original_string(_orig), is_branch(_br), branch_target(_bt) {}
};

enum Stage { IDLE, FETCH, DECODE, ISSUE, EXECUTE, WRITEBACK, COMPLETE };
string stageToString(Stage s) {
    const char* names[] = {"IDLE", "FETCH", "DECODE", "ISSUE",
                           "EXECUTE", "WRITEBACK", "COMPLETE"};
    return (s <= COMPLETE) ? names[s] : "UNKNOWN";
}

struct PipelineState {
    Stage current_stage;
    ExecUnit assigned_unit;
    int cycles_in_stage;
    int total_cycles;
    bool stalled;
    string stall_reason;
    int issue_cycle;
    int complete_cycle;

    PipelineState() : current_stage(IDLE), assigned_unit(ANY_UNIT),
                     cycles_in_stage(0), total_cycles(0), stalled(false),
                     issue_cycle(-1), complete_cycle(-1) {}
};

// --- (Scoreboard and ExecUnits classes are unchanged) ---
class RegisterScoreboard {
private:
    struct RegInfo { bool busy; int writer_id; int ready_cycle; };
    vector<RegInfo> regs;
    const int num_registers;
public:
    RegisterScoreboard(int num_regs = 32) : num_registers(num_regs), regs(num_regs, {false, -1, -1}) {}
    bool isBusy(int reg, int current_cycle) {
        if (reg < 0 || reg >= num_registers) return false;
        return regs[reg].busy && regs[reg].ready_cycle > current_cycle;
    }
    void markBusy(int reg, int instr_id, int ready_cycle) {
        if (reg >= 0 && reg < num_registers) {
            regs[reg] = {true, instr_id, ready_cycle};
        }
    }
    void clearBusy(int reg) {
        if (reg >= 0 && reg < num_registers) {
            regs[reg].busy = false; 
        }
    }
    int getWriter(int reg) {
        return (reg >= 0 && reg < num_registers) ? regs[reg].writer_id : -1;
    }
};

class ExecutionUnits {
private:
    map<ExecUnit, int> available;
    map<ExecUnit, int> capacity;
public:
    ExecutionUnits() {
        capacity[ALU_UNIT] = 2;
        capacity[FPU_UNIT] = 1;
        capacity[MEM_UNIT] = 1;
        capacity[BRANCH_UNIT] = 1;
        available = capacity;
    }
    bool isAvailable(ExecUnit unit) { return available.count(unit) ? available[unit] > 0 : false; }
    bool allocate(ExecUnit unit) {
        if (isAvailable(unit)) {
            available[unit]--;
            return true;
        }
        return false;
    }
    void release(ExecUnit unit) {
        if (available.count(unit) && available[unit] < capacity[unit]) {
            available[unit]++;
        }
    }
    void reset() { available = capacity; }
};

// --- (Statistics struct is unchanged) ---
struct Statistics {
    int total_cycles;
    int instructions_completed;
    int total_stalls;
    int raw_hazards;
    int war_hazards; // Not implemented
    int waw_hazords; // Not implemented
    int structural_hazards;
    int branch_mispredictions; // Not implemented
    double ipc;

    Statistics() : total_cycles(0), instructions_completed(0), total_stalls(0),
                  raw_hazards(0), war_hazards(0), waw_hazords(0),
                  structural_hazards(0), branch_mispredictions(0), ipc(0.0) {}

    void calculate() {
        ipc = (total_cycles > 0) ? (double)instructions_completed / total_cycles : 0.0;
    }
};

// --- (detectHazards is unchanged) ---
bool detectHazards(const Instruction& instr, PipelineState& state,
                   RegisterScoreboard& scoreboard, ExecutionUnits& units,
                   int cycle, Statistics& stats) {
    bool hazard = false;
    string reason = "";

    if (scoreboard.isBusy(instr.src1, cycle)) {
        hazard = true;
        reason = "RAW on R" + to_string(instr.src1) +
                 " (writer: I" + to_string(scoreboard.getWriter(instr.src1)) + ")";
        #pragma omp atomic
        stats.raw_hazards++;
    } else if (scoreboard.isBusy(instr.src2, cycle)) {
        hazard = true;
        reason = "RAW on R" + to_string(instr.src2) +
                 " (writer: I" + to_string(scoreboard.getWriter(instr.src2)) + ")";
        #pragma omp atomic
        stats.raw_hazards++;
    }

    ExecUnit required = getExecUnit(instr.opcode);
    if (!hazard && !units.isAvailable(required)) {
        hazard = true;
        reason = "Structural - " + unitToString(required) + " busy";
        #pragma omp atomic
        stats.structural_hazards++;
    }

    if (hazard) {
        state.stalled = true;
        state.stall_reason = reason;
        #pragma omp atomic
        stats.total_stalls++;
        return false;
    }

    state.stalled = false;
    state.stall_reason = "";
    return true;
}

// NEW function to load instructions from a JSON string array
vector<Instruction> loadInstructionsFromString(const vector<string>& instruction_strings) {
    vector<Instruction> instructions;
    int id = 1;
    int line_num = 0;

    for (const auto& line : instruction_strings) {
        line_num++;
        if (line.empty() || line[0] == '#') continue;

        istringstream iss(line);
        string opcode_str, dest_str, src1_str, src2_str, branch_target_str;
        iss >> opcode_str;
        if (opcode_str.empty()) continue;

        Opcode opcode = stringToOpcode(opcode_str);
        int dest = -1, src1 = -1, src2 = -1;
        bool is_branch = false;
        int branch_target = 0;

        if (opcode == LOAD) {
            iss >> dest_str >> src1_str;
            dest = parseRegister(dest_str);
            src1 = parseRegister(src1_str);
        } else if (opcode == STORE) {
            iss >> dest_str >> src1_str;
            dest = parseRegister(dest_str);
            src1 = parseRegister(src1_str);
        } else if (opcode == BEQ || opcode == BNE) {
            iss >> src1_str >> src2_str >> branch_target_str;
            src1 = parseRegister(src1_str);
            src2 = parseRegister(src2_str);
            branch_target = stoi(branch_target_str);
            is_branch = true;
        } else if (opcode == JMP) {
            iss >> branch_target_str;
            branch_target = stoi(branch_target_str);
            is_branch = true;
        } else {
            iss >> dest_str >> src1_str >> src2_str;
            dest = parseRegister(dest_str);
            src1 = parseRegister(src1_str);
            src2 = parseRegister(src2_str);
        }

        instructions.push_back(Instruction(id++, opcode, src1, src2, dest,
                                          line, is_branch, branch_target));
    }
    return instructions;
}


// NEW function to capture the pipeline state for a given cycle
json captureCycleState(int cycle, const vector<Instruction>& instrs,
                       const vector<PipelineState>& states) {
    json cycle_data;
    cycle_data["cycle"] = cycle;

    // A map to hold instructions for each stage
    map<string, vector<string>> stage_map;
    stage_map["FETCH"] = {};
    stage_map["DECODE"] = {};
    stage_map["ISSUE"] = {};
    stage_map["EXECUTE"] = {};
    stage_map["WRITEBACK"] = {};

    vector<json> stalls;

    for (size_t i = 0; i < instrs.size(); i++) {
        if (states[i].current_stage != IDLE && states[i].current_stage != COMPLETE) {
            stage_map[stageToString(states[i].current_stage)].push_back(instrs[i].original_string);
        }
        if (states[i].stalled) {
            json stall_info;
            stall_info["instruction"] = instrs[i].original_string;
            stall_info["reason"] = states[i].stall_reason;
            stalls.push_back(stall_info);
        }
    }

    cycle_data["stages"] = stage_map;
    cycle_data["stalls"] = stalls;
    return cycle_data;
}


int main() {
    omp_set_num_threads(4);

    // Read instruction list from standard input
    json input_json;
    try {
        cin >> input_json;
    } catch (json::parse_error& e) {
        json error_json;
        error_json["error"] = "Invalid JSON input.";
        error_json["details"] = e.what();
        cout << error_json.dump() << endl;
        return 1;
    }

    vector<string> instruction_strings = input_json["instructions"].get<vector<string>>();
    vector<Instruction> instructions = loadInstructionsFromString(instruction_strings);

    if (instructions.empty()) {
        json error_json;
        error_json["error"] = "No instructions loaded from input.";
        cout << error_json.dump() << endl;
        return 1;
    }

    // Initialize simulation structures
    vector<PipelineState> states(instructions.size());
    RegisterScoreboard scoreboard(32);
    ExecutionUnits exec_units;
    Statistics stats;

    // NEW: Vector to store the state of every cycle
    vector<json> cycle_history;

    int cycle = 0;
    int completed = 0;
    const int MAX_CYCLES = 500;

    // Main simulation loop
    while (completed < instructions.size() && cycle < MAX_CYCLES) {
        cycle++;
        
        // --- (All simulation logic stages: WRITEBACK, EXECUTE, ISSUE, DECODE, FETCH) ---
        // --- (This logic is unchanged from your original file) ---

        // WriteBack stage (parallel)
        #pragma omp parallel for schedule(dynamic)
        for (int i = 0; i < instructions.size(); i++) {
            if (states[i].current_stage == WRITEBACK) {
                scoreboard.clearBusy(instructions[i].dest);
                if (states[i].assigned_unit != ANY_UNIT) {
                    #pragma omp critical(ExecUnitRelease)
                    {
                        exec_units.release(states[i].assigned_unit);
                    }
                }
                states[i].current_stage = COMPLETE;
                states[i].complete_cycle = cycle;
                #pragma omp atomic
                completed++;
            }
        }
        #pragma omp barrier

        // Execute stage (parallel with latency)
        #pragma omp parallel for schedule(dynamic)
        for (int i = 0; i < instructions.size(); i++) {
            if (states[i].current_stage == EXECUTE) {
                states[i].cycles_in_stage++;
                int required_cycles = getLatency(instructions[i].opcode);

                if (states[i].cycles_in_stage >= required_cycles) {
                    states[i].current_stage = WRITEBACK;
                    states[i].cycles_in_stage = 0;
                }
            }
        }
        #pragma omp barrier

        // Issue stage (sequential for resource allocation)
        for (int i = 0; i < instructions.size(); i++) {
            if (states[i].current_stage == ISSUE) {
                ExecUnit unit = getExecUnit(instructions[i].opcode);
                if (exec_units.allocate(unit)) {
                    states[i].current_stage = EXECUTE;
                    states[i].assigned_unit = unit;
                    states[i].cycles_in_stage = 0;
                    states[i].issue_cycle = cycle;
                    int ready_at_cycle = cycle + getLatency(instructions[i].opcode);
                    scoreboard.markBusy(instructions[i].dest, instructions[i].id, ready_at_cycle);
                }
            }
        }

        // Decode stage (sequential for hazard detection)
        for (int i = 0; i < instructions.size(); i++) {
            if (states[i].current_stage == DECODE) {
                if (detectHazards(instructions[i], states[i], scoreboard,
                                  exec_units, cycle, stats)) {
                    states[i].current_stage = ISSUE;
                }
            }
        }

        // Fetch stage (parallel)
        #pragma omp parallel for schedule(dynamic)
        for (int i = 0; i < instructions.size(); i++) {
            if (states[i].current_stage == FETCH) {
                states[i].current_stage = DECODE;
                states[i].cycles_in_stage = 0;
            } else if (states[i].current_stage == IDLE) {
                states[i].current_stage = FETCH;
            }
        }

        // Update total cycles for active instructions
        #pragma omp parallel for
        for (int i = 0; i < instructions.size(); i++) {
            if (states[i].current_stage != IDLE &&
                states[i].current_stage != COMPLETE) {
                states[i].total_cycles++;
            }
        }
        
        // -----------------------------------------------------------------
        // NEW: Capture the state of this cycle and save it
        // -----------------------------------------------------------------
        cycle_history.push_back(captureCycleState(cycle, instructions, states));

    } // End main simulation loop

    // Calculate final statistics
    stats.total_cycles = cycle;
    stats.instructions_completed = completed;
    stats.calculate();

    // -----------------------------------------------------------------
    // NEW: Build the final JSON output
    // -----------------------------------------------------------------
    json final_result;
    
    // Add stats
    json stats_json;
    stats_json["totalCycles"] = stats.total_cycles;
    stats_json["instructionsCompleted"] = stats.instructions_completed;
    stats_json["ipc"] = stats.ipc;
    stats_json["totalStalls"] = stats.total_stalls;
    stats_json["rawHazards"] = stats.raw_hazards;
    stats_json["warHazards"] = stats.war_hazards;
    stats_json["wawHazards"] = stats.waw_hazords;
    stats_json["structuralHazards"] = stats.structural_hazards;
    stats_json["branchMispredictions"] = stats.branch_mispredictions;
    
    final_result["stats"] = stats_json;
    
    // Add cycle history
    final_result["cycles"] = cycle_history;

    // Create the final object format your UI expects
    json output;
    output["result"] = final_result;

    // Print the single JSON object to standard output
    cout << output.dump(2) << endl;

    return 0;
}
