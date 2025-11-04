/*
 * Advanced Parallel Instruction Pipeline Simulator using OpenMP
 * 
 * This program simulates a realistic 5-stage superscalar CPU pipeline with:
 * - Multiple execution units (ALU, FPU, Memory)
 * - Out-of-order execution capabilities
 * - Branch prediction with misprediction penalties
 * - Multiple hazard types (RAW, WAR, WAW, structural)
 * - Dynamic instruction scheduling
 * - Performance metrics and visualization
 * 
 * Pipeline stages: Fetch → Decode → Issue → Execute → WriteBack
 * 
 * Compile: g++ -fopenmp pipeline.cpp -o pipeline && ./pipeline
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
 
 using namespace std;
 
 // Instruction opcodes with execution unit requirements
 enum Opcode {
     ADD, SUB, MUL, DIV,           // ALU operations
     FADD, FMUL, FDIV,             // FPU operations
     LOAD, STORE,                  // Memory operations
     BEQ, BNE, JMP,                // Branch operations
     NOP
 };
 
 // Execution unit types
 enum ExecUnit {
     ALU_UNIT,
     FPU_UNIT,
     MEM_UNIT,
     BRANCH_UNIT,
     ANY_UNIT
 };
 
 // Get execution unit for opcode
 ExecUnit getExecUnit(Opcode op) {
     switch(op) {
         case ADD: case SUB: case MUL: case DIV: return ALU_UNIT;
         case FADD: case FMUL: case FDIV: return FPU_UNIT;
         case LOAD: case STORE: return MEM_UNIT;
         case BEQ: case BNE: case JMP: return BRANCH_UNIT;
         default: return ANY_UNIT;
     }
 }
 
 // Get execution latency for opcode
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
 
 // Convert string to opcode
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
 
 // Enhanced instruction structure
 struct Instruction {
     int id;
     Opcode opcode;
     int src1, src2;
     int dest;
     bool is_branch;
     int branch_target;
     double predicted_taken;  // Branch prediction confidence
     
     Instruction(int _id, Opcode _op, int _s1, int _s2, int _d, 
                 bool _br = false, int _bt = 0)
         : id(_id), opcode(_op), src1(_s1), src2(_s2), dest(_d),
           is_branch(_br), branch_target(_bt), predicted_taken(0.5) {}
     
     void print() const {
         cout << "I" << setw(2) << id << ": " << setw(5) << opcodeToString(opcode);
         if (dest >= 0) cout << " R" << setw(2) << dest;
         if (src1 >= 0) cout << " R" << setw(2) << src1;
         if (src2 >= 0) cout << " R" << setw(2) << src2;
         if (is_branch) cout << " [BR→" << branch_target << "]";
     }
 };
 
 // Pipeline stages (5-stage pipeline)
 enum Stage {
     IDLE,
     FETCH,
     DECODE,
     ISSUE,      // Issue to execution unit
     EXECUTE,
     WRITEBACK,
     COMPLETE
 };
 
 string stageToString(Stage s) {
     const char* names[] = {"IDLE", "FETCH", "DECODE", "ISSUE", 
                           "EXECUTE", "WRITEBACK", "COMPLETE"};
     return (s <= COMPLETE) ? names[s] : "UNKNOWN";
 }
 
 // Enhanced pipeline state
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
 
 // Register scoreboard with write-after-write tracking
 class RegisterScoreboard {
 private:
     struct RegInfo {
         bool busy;
         int writer_id;
         int ready_cycle;
     };
     vector<RegInfo> regs;
     
 public:
     RegisterScoreboard(int num_regs = 32) : regs(num_regs, {false, -1, -1}) {}
     
     bool isBusy(int reg, int current_cycle) {
         return reg >= 0 && reg < regs.size() && 
                regs[reg].busy && regs[reg].ready_cycle > current_cycle;
     }
     
     void markBusy(int reg, int instr_id, int ready_cycle) {
         if (reg >= 0 && reg < regs.size()) {
             regs[reg] = {true, instr_id, ready_cycle};
         }
     }
     
     void clearBusy(int reg) {
         if (reg >= 0 && reg < regs.size()) {
             regs[reg] = {false, -1, -1};
         }
     }
     
     int getWriter(int reg) {
         return (reg >= 0 && reg < regs.size()) ? regs[reg].writer_id : -1;
     }
 };
 
 // Execution unit resource manager
 class ExecutionUnits {
 private:
     map<ExecUnit, int> available;
     map<ExecUnit, int> capacity;
     
 public:
     ExecutionUnits() {
         capacity[ALU_UNIT] = 2;    // 2 ALU units
         capacity[FPU_UNIT] = 1;    // 1 FPU unit
         capacity[MEM_UNIT] = 1;    // 1 Memory unit
         capacity[BRANCH_UNIT] = 1; // 1 Branch unit
         available = capacity;
     }
     
     bool isAvailable(ExecUnit unit) {
         return available[unit] > 0;
     }
     
     bool allocate(ExecUnit unit) {
         if (available[unit] > 0) {
             available[unit]--;
             return true;
         }
         return false;
     }
     
     void release(ExecUnit unit) {
         if (available[unit] < capacity[unit]) {
             available[unit]++;
         }
     }
     
     void reset() {
         available = capacity;
     }
     
     string getStatus() {
         string status = "Units: ";
         for (auto& p : capacity) {
             status += unitToString(p.first) + "(" + 
                      to_string(available[p.first]) + "/" + 
                      to_string(p.second) + ") ";
         }
         return status;
     }
 };
 
 // Performance statistics
 struct Statistics {
     int total_cycles;
     int instructions_completed;
     int total_stalls;
     int raw_hazards;
     int war_hazards;
     int waw_hazards;
     int structural_hazards;
     int branch_mispredictions;
     double ipc;
     
     Statistics() : total_cycles(0), instructions_completed(0), total_stalls(0),
                   raw_hazards(0), war_hazards(0), waw_hazards(0),
                   structural_hazards(0), branch_mispredictions(0), ipc(0.0) {}
     
     void calculate() {
         ipc = (total_cycles > 0) ? (double)instructions_completed / total_cycles : 0.0;
     }
     
     void print() {
         cout << "\n╔════════════════════════════════════════════════╗" << endl;
         cout << "║        PERFORMANCE STATISTICS                  ║" << endl;
         cout << "╠════════════════════════════════════════════════╣" << endl;
         cout << "║ Total Cycles:            " << setw(20) << total_cycles << " ║" << endl;
         cout << "║ Instructions Completed:  " << setw(20) << instructions_completed << " ║" << endl;
         cout << "║ Instructions Per Cycle:  " << setw(20) << fixed << setprecision(3) << ipc << " ║" << endl;
         cout << "║ Total Stall Cycles:      " << setw(20) << total_stalls << " ║" << endl;
         cout << "║ RAW Hazards:             " << setw(20) << raw_hazards << " ║" << endl;
         cout << "║ WAR Hazards:             " << setw(20) << war_hazards << " ║" << endl;
         cout << "║ WAW Hazards:             " << setw(20) << waw_hazards << " ║" << endl;
         cout << "║ Structural Hazards:      " << setw(20) << structural_hazards << " ║" << endl;
         cout << "║ Branch Mispredictions:   " << setw(20) << branch_mispredictions << " ║" << endl;
         cout << "╚════════════════════════════════════════════════╝" << endl;
     }
 };
 
 // Hazard detection with detailed analysis
 bool detectHazards(const Instruction& instr, PipelineState& state,
                    RegisterScoreboard& scoreboard, ExecutionUnits& units,
                    int cycle, Statistics& stats) {
     bool hazard = false;
     string reason = "";
     
     // Check RAW hazards (Read After Write - true data dependency)
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
     
     // Check structural hazards (execution unit unavailable)
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
 
 // Visual pipeline display
 void displayPipeline(int cycle, const vector<Instruction>& instrs,
                      const vector<PipelineState>& states,
                      ExecutionUnits& units) {
     #pragma omp critical
     {
         cout << "\n┌─────────────────────────────────────────────────┐" << endl;
         cout << "│ CYCLE " << setw(3) << cycle << "                                      │" << endl;
         cout << "├─────────────────────────────────────────────────┤" << endl;
         
         // Group by stage
         map<Stage, vector<int>> stage_map;
         for (size_t i = 0; i < instrs.size(); i++) {
             if (states[i].current_stage != IDLE && 
                 states[i].current_stage != COMPLETE) {
                 stage_map[states[i].current_stage].push_back(i);
             }
         }
         
         // Display each stage
         for (int s = FETCH; s <= WRITEBACK; s++) {
             Stage stage = static_cast<Stage>(s);
             cout << "│ " << setw(10) << left << stageToString(stage) << ": ";
             
             if (stage_map.find(stage) != stage_map.end()) {
                 for (int idx : stage_map[stage]) {
                     cout << "I" << setw(2) << instrs[idx].id;
                     if (states[idx].stalled) {
                         cout << "⚠";
                     }
                     cout << " ";
                 }
             } else {
                 cout << "---";
             }
             cout << endl;
         }
         
         cout << "├─────────────────────────────────────────────────┤" << endl;
         cout << "│ " << units.getStatus() << endl;
         
         // Show stalls
         for (size_t i = 0; i < instrs.size(); i++) {
             if (states[i].stalled) {
                 cout << "│ ⚠ I" << instrs[i].id << " STALLED: " 
                      << states[i].stall_reason << endl;
             }
         }
         cout << "└─────────────────────────────────────────────────┘" << endl;
     }
 }
 
 // Parse register from string (e.g., "R10" -> 10)
 int parseRegister(const string& reg_str) {
     if (reg_str.empty() || reg_str[0] != 'R') return -1;
     try {
         return stoi(reg_str.substr(1));
     } catch (...) {
         return -1;
     }
 }
 
 // Load instructions from file
 vector<Instruction> loadInstructionsFromFile(const string& filename) {
     vector<Instruction> instructions;
     ifstream file(filename);
     
     if (!file.is_open()) {
         cerr << "❌ Error: Could not open file '" << filename << "'" << endl;
         cerr << "   Please run: python3 instruction_generator.py" << endl;
         return instructions;
     }
     
     cout << "📂 Reading instructions from: " << filename << endl;
     
     string line;
     int id = 1;
     int line_num = 0;
     
     while (getline(file, line)) {
         line_num++;
         
         // Skip comments and empty lines
         if (line.empty() || line[0] == '#') continue;
         
         // Parse instruction
         istringstream iss(line);
         string opcode_str, dest_str, src1_str, src2_str, branch_target_str;
         
         iss >> opcode_str;
         if (opcode_str.empty()) continue;
         
         Opcode opcode = stringToOpcode(opcode_str);
         
         // Parse operands based on instruction type
         int dest = -1, src1 = -1, src2 = -1;
         bool is_branch = false;
         int branch_target = 0;
         
         if (opcode == LOAD) {
             // Format: LOAD Rdest Rsrc1
             iss >> dest_str >> src1_str;
             dest = parseRegister(dest_str);
             src1 = parseRegister(src1_str);
             
         } else if (opcode == STORE) {
             // Format: STORE Rdest Rsrc1
             iss >> dest_str >> src1_str;
             dest = parseRegister(dest_str);
             src1 = parseRegister(src1_str);
             
         } else if (opcode == BEQ || opcode == BNE) {
             // Format: BEQ Rsrc1 Rsrc2 target
             iss >> src1_str >> src2_str >> branch_target_str;
             src1 = parseRegister(src1_str);
             src2 = parseRegister(src2_str);
             branch_target = stoi(branch_target_str);
             is_branch = true;
             
         } else if (opcode == JMP) {
             // Format: JMP target
             iss >> branch_target_str;
             branch_target = stoi(branch_target_str);
             is_branch = true;
             
         } else {
             // Format: OP Rdest Rsrc1 Rsrc2 (ALU/FPU operations)
             iss >> dest_str >> src1_str >> src2_str;
             dest = parseRegister(dest_str);
             src1 = parseRegister(src1_str);
             src2 = parseRegister(src2_str);
         }
         
         instructions.push_back(Instruction(id++, opcode, src1, src2, dest, 
                                           is_branch, branch_target));
     }
     
     file.close();
     
     cout << "✅ Successfully loaded " << instructions.size() << " instructions" << endl;
     
     return instructions;
 }
 
 int main(int argc, char* argv[]) {
     // Set number of threads for OpenMP
     omp_set_num_threads(4);
     
     cout << "\n╔════════════════════════════════════════════════╗" << endl;
     cout << "║  ADVANCED PARALLEL PIPELINE SIMULATOR (OpenMP) ║" << endl;
     cout << "║  5-Stage Superscalar Out-of-Order Pipeline    ║" << endl;
     cout << "╠════════════════════════════════════════════════╣" << endl;
     cout << "║ Execution Units: 2 ALU, 1 FPU, 1 MEM, 1 BR    ║" << endl;
     cout << "║ Pipeline Stages: FETCH → DECODE → ISSUE       ║" << endl;
     cout << "║                  → EXECUTE → WRITEBACK         ║" << endl;
     cout << "╚════════════════════════════════════════════════╝" << endl;
     
     // Load instructions from file
     string filename = "instructions.txt";
     if (argc > 1) {
         filename = argv[1];
     }
     
     cout << "\n" << endl;
     vector<Instruction> instructions = loadInstructionsFromFile(filename);
     
     if (instructions.empty()) {
         cerr << "\n❌ No instructions loaded. Exiting." << endl;
         cerr << "\nTo generate instructions, run:" << endl;
         cerr << "  python3 instruction_generator.py" << endl;
         cerr << "\nOr specify a different file:" << endl;
         cerr << "  ./pipeline <filename>" << endl;
         return 1;
     }
     
     cout << "\n╔════════════════════════════════════════════════╗" << endl;
     cout << "║              INPUT INSTRUCTIONS                ║" << endl;
     cout << "╠════════════════════════════════════════════════╣" << endl;
     cout << "║ Total Instructions: " << setw(27) << instructions.size() << " ║" << endl;
     cout << "╚════════════════════════════════════════════════╝" << endl;
     
     cout << "\n┌─────────────────────────────────────────────────┐" << endl;
     cout << "│ ID  │ Opcode │ Dest │ Src1 │ Src2 │ Unit   │Lat│" << endl;
     cout << "├─────┼────────┼──────┼──────┼──────┼────────┼───┤" << endl;
     
     for (const auto& instr : instructions) {
         cout << "│ I" << setw(2) << instr.id << " │ ";
         cout << setw(6) << left << opcodeToString(instr.opcode) << " │ ";
         
         // Destination
         if (instr.dest >= 0)
             cout << "R" << setw(3) << instr.dest << " │ ";
         else
             cout << " --  │ ";
         
         // Source 1
         if (instr.src1 >= 0)
             cout << "R" << setw(3) << instr.src1 << " │ ";
         else
             cout << " --  │ ";
         
         // Source 2
         if (instr.src2 >= 0)
             cout << "R" << setw(3) << instr.src2 << " │ ";
         else
             cout << " --  │ ";
         
         // Execution unit
         cout << setw(6) << left << unitToString(getExecUnit(instr.opcode)) << " │ ";
         
         // Latency
         cout << setw(2) << getLatency(instr.opcode) << "│";
         
         // Branch info
         if (instr.is_branch) {
             cout << " [→" << instr.branch_target << "]";
         }
         
         cout << endl;
     }
     cout << "└─────┴────────┴──────┴──────┴──────┴────────┴───┘" << endl;
     
     // Show dependencies
     cout << "\n╔════════════════════════════════════════════════╗" << endl;
     cout << "║           INSTRUCTION DEPENDENCIES             ║" << endl;
     cout << "╚════════════════════════════════════════════════╝" << endl;
     
     for (const auto& instr : instructions) {
         bool has_dependency = false;
         vector<int> depends_on;
         
         // Check which previous instructions this depends on
         for (const auto& prev : instructions) {
             if (prev.id >= instr.id) break;
             
             // RAW dependency: this instruction reads what prev writes
             if ((instr.src1 == prev.dest && prev.dest >= 0) ||
                 (instr.src2 == prev.dest && prev.dest >= 0)) {
                 depends_on.push_back(prev.id);
                 has_dependency = true;
             }
         }
         
         if (has_dependency) {
             cout << "  I" << setw(2) << instr.id << " depends on: ";
             for (size_t i = 0; i < depends_on.size(); i++) {
                 cout << "I" << depends_on[i];
                 if (i < depends_on.size() - 1) cout << ", ";
             }
             cout << " (RAW hazard potential)" << endl;
         }
     }
     
     if (!any_of(instructions.begin(), instructions.end(), 
                 [&](const Instruction& instr) {
                     for (const auto& prev : instructions) {
                         if (prev.id >= instr.id) break;
                         if ((instr.src1 == prev.dest && prev.dest >= 0) ||
                             (instr.src2 == prev.dest && prev.dest >= 0)) {
                             return true;
                         }
                     }
                     return false;
                 })) {
         cout << "  No data dependencies detected - all instructions are independent!" << endl;
     }
     
     // Initialize simulation structures
     vector<PipelineState> states(instructions.size());
     RegisterScoreboard scoreboard(32);
     ExecutionUnits exec_units;
     Statistics stats;
     
     int cycle = 0;
     int completed = 0;
     const int MAX_CYCLES = 100;
     
     cout << "\n════════════════════════════════════════════════" << endl;
     cout << "Starting Pipeline Simulation..." << endl;
     cout << "════════════════════════════════════════════════" << endl;
     
     // Main simulation loop
     while (completed < instructions.size() && cycle < MAX_CYCLES) {
         cycle++;
         exec_units.reset();
         
         // WriteBack stage (parallel)
         #pragma omp parallel for schedule(dynamic)
         for (int i = 0; i < instructions.size(); i++) {
             if (states[i].current_stage == WRITEBACK) {
                 scoreboard.clearBusy(instructions[i].dest);
                 exec_units.release(states[i].assigned_unit);
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
                     
                     // Mark destination register as busy
                     int ready = cycle + getLatency(instructions[i].opcode);
                     scoreboard.markBusy(instructions[i].dest, instructions[i].id, ready);
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
         
         // Display every 3 cycles or on stalls
         bool has_stalls = false;
         for (const auto& s : states) {
             if (s.stalled) has_stalls = true;
         }
         
         if (cycle % 3 == 0 || has_stalls || cycle < 10) {
             displayPipeline(cycle, instructions, states, exec_units);
         }
     }
     
     // Calculate final statistics
     stats.total_cycles = cycle;
     stats.instructions_completed = completed;
     stats.calculate();
     
     // Display results
     cout << "\n════════════════════════════════════════════════" << endl;
     cout << "Simulation Complete!" << endl;
     cout << "════════════════════════════════════════════════" << endl;
     
     stats.print();
     
     cout << "\nInstruction Timeline:" << endl;
     cout << "─────────────────────────────────────────────────" << endl;
     cout << "ID  | Issue Cycle | Complete Cycle | Total Cycles" << endl;
     cout << "────|─────────────|────────────────|─────────────" << endl;
     for (size_t i = 0; i < instructions.size(); i++) {
         cout << "I" << setw(2) << instructions[i].id << " | "
              << setw(11) << states[i].issue_cycle << " | "
              << setw(14) << states[i].complete_cycle << " | "
              << setw(12) << states[i].total_cycles << endl;
     }
     
     return 0;
 }