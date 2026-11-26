// ============================================================================
//  SIBAT NA - backend/include/server.hpp
//  HTTP server surface. Implementation lives in src/server.cpp.
// ============================================================================
#pragma once

#include "core.hpp"
#include <string>

namespace sibat {

class Server {
public:
    Server(App& app, std::string root, int port);
    // Blocks forever. Returns false only if the socket could not start.
    bool start();

private:
    App& app_;
    std::string root_;
    int port_;
};

} // namespace sibat
