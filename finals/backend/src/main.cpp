// ============================================================================
//  SIBAT NA - backend/src/main.cpp
//  Entry point. Finds the project root, loads persisted state, starts the API.
// ============================================================================
#include "../include/core.hpp"
#include "../include/server.hpp"

#include <filesystem>
#include <iostream>
#include <string>

namespace fs = std::filesystem;

int main(int argc, char** argv) {
    int port = 8787;
    std::string rootArg;
    std::string dataArg;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) port = std::stoi(argv[++i]);
        else if (arg == "--root" && i + 1 < argc) rootArg = argv[++i];
        else if (arg == "--data" && i + 1 < argc) dataArg = argv[++i];
        else if (arg == "--help" || arg == "-h") {
            std::cout << "Sibat Na demo engine\n"
                         "  --port <n>   HTTP port (default 8787)\n"
                         "  --root <dir> project root that contains index.html\n"
                         "  --data <file> state file (default <root>/data/state.json)\n";
            return 0;
        }
    }

    fs::path root;
    if (!rootArg.empty()) {
        root = fs::weakly_canonical(fs::path(rootArg));
    } else {
        std::error_code ec;
        fs::path exe = fs::weakly_canonical(fs::path(argv[0]), ec);
        if (ec) exe = fs::path(argv[0]);
        fs::path dir = exe.parent_path();
        // exe lives in <root>/backend or <root>/backend/build
        if (dir.filename() == "backend") root = dir.parent_path();
        else if (dir.parent_path().filename() == "backend") root = dir.parent_path().parent_path();
        else root = fs::current_path();
        if (!fs::exists(root / "index.html", ec)) {
            if (fs::exists(fs::current_path() / "index.html", ec)) root = fs::current_path();
        }
    }

    fs::path dataFile = dataArg.empty()
        ? root / "data" / "state.json"
        : fs::path(dataArg);
    fs::create_directories(dataFile.parent_path());

    std::cout << "==============================================================\n";
    std::cout << "  SIBAT NA  ·  C++ demo engine\n";
    std::cout << "  root: " << root.string() << "\n";
    std::cout << "  data: " << dataFile.string() << "\n";
    std::cout << "==============================================================\n";

    sibat::App app(dataFile.string());
    app.load();

    sibat::Server server(app, root.string(), port);
    return server.start() ? 0 : 1;
}
