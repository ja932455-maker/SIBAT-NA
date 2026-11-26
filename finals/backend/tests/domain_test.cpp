// ============================================================================
//  SIBAT NA - backend/tests/domain_test.cpp
//  Plain C++ assertions (no framework). Run:  sibat-tests.exe
// ============================================================================
#include "../include/core.hpp"
#include "../include/json.hpp"

#include <cmath>
#include <iostream>
#include <string>

using namespace sibat;

static int g_pass = 0;
static int g_fail = 0;

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (cond) { ++g_pass; }                                                  \
        else {                                                                   \
            ++g_fail;                                                            \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << "  " << #cond \
                      << "\n";                                                   \
        }                                                                        \
    } while (0)

static bool near(double a, double b, double eps = 0.001) {
    return std::fabs(a - b) <= eps;
}

// ---------------------------------------------------------------------------
//  JSON
// ---------------------------------------------------------------------------
static void testJson() {
    Json j = Json::parse(R"({"name":"Sibat Na","ok":true,"fare":15.5,"tags":["a","b"],"n":null})");
    CHECK(j.at("name").asString() == "Sibat Na");
    CHECK(j.at("ok").asBool());
    CHECK(near(j.at("fare").asDouble(), 15.5));
    CHECK(j.at("tags").size() == 2);
    CHECK(j.at("tags").elements()[1].asString() == "b");
    CHECK(j.at("n").isNull());

    // unicode escape roundtrip
    Json u = Json::parse(R"({"peso":"\u20b1","emoji":"\ud83d\ude97"})");
    CHECK(u.at("peso").asString() == "\xE2\x82\xB1");
    CHECK(u.at("emoji").asString() == "\xF0\x9F\x9A\x97");

    // dump -> parse roundtrip keeps values
    Json back = Json::parse(j.dump());
    CHECK(back.at("name").asString() == "Sibat Na");
    CHECK(back.at("tags").size() == 2);

    // escaped quotes/newlines survive
    Json s = Json::object();
    s["text"] = "line1\nline2 \"quoted\"";
    Json s2 = Json::parse(s.dump());
    CHECK(s2.at("text").asString() == "line1\nline2 \"quoted\"");
}

// ---------------------------------------------------------------------------
//  FARE
// ---------------------------------------------------------------------------
static void testFare() {
    Settings s; // base 15, first 4 km included, 2.50 / km
    CHECK(near(computeFare(0, s), 15.0));
    CHECK(near(computeFare(2.5, s), 15.0));
    CHECK(near(computeFare(4, s), 15.0));
    CHECK(near(computeFare(6, s), 20.0));
    CHECK(near(computeFare(10, s), 30.0));
    CHECK(near(computeFare(4.333, s), 15.83));
}

static void testQueueKeys() {
    CHECK(makeQueueKey("Quezon City", "Makati") == "quezon-city>makati");
    CHECK(makeQueueKey("", "") == "shared>shared");
    CHECK(makeQueueKey("  Pasay  ", "Taguig") == "pasay>taguig");
}

static Ride mkRide(AppState& st, const std::string& id, const std::string& area, long long at) {
    Ride r;
    r.id = id;
    r.code = "SBT-" + id;
    r.pickupLabel = area;
    r.destLabel = "Makati";
    r.pickupArea = area;
    r.destArea = "Makati";
    r.queueKey = makeQueueKey(area, "Makati");
    r.status = "pending";
    r.createdAt = at;
    r.pickupLat = 14.65;
    r.pickupLng = 121.03;
    r.destLat = 14.55;
    r.destLng = 121.02;
    r.distanceKm = 12;
    r.fare = computeFare(r.distanceKm, st.settings);
    st.rides.push_back(r);
    return r;
}

// ---------------------------------------------------------------------------
//  QUEUE + DISPATCH
// ---------------------------------------------------------------------------
static void testQueueAndDispatch() {
    AppState st = seedState();
    st.rides.clear();
    for (auto& a : st.accounts) if (a.role == "driver") a.status = "offline";

    mkRide(st, "R1", "Quezon City", 1000);
    mkRide(st, "R2", "Quezon City", 2000);
    mkRide(st, "R3", "Pasay", 1500);

    CHECK(queuePosition(st, *st.ride("R1")) == 1);
    CHECK(queuePosition(st, *st.ride("R2")) == 2);
    CHECK(queuePosition(st, *st.ride("R3")) == 1);

    std::string err;
    CHECK(!acceptRide(st, "DRV-100", "R1", &err)); // no offer yet

    // no drivers online -> offer fails with reason
    Ride* offered = offerRide(st, *st.ride("R1"), &err);
    CHECK(offered == nullptr);
    CHECK(err.find("No driver") != std::string::npos);

    Account* d = st.account("DRV-100");
    d->status = "online";
    d->lat = 14.65; d->lng = 121.03; // at the pickup

    offered = offerRide(st, *st.ride("R1"), &err);
    CHECK(offered != nullptr);
    CHECK(st.ride("R1")->status == "offered");
    CHECK(st.ride("R1")->driverId == "DRV-100");
    CHECK(d->status == "busy");
    CHECK(queuePosition(st, *st.ride("R1")) == 0);

    CHECK(acceptRide(st, "DRV-100", "R1", &err));
    CHECK(st.ride("R1")->status == "arriving");
    CHECK(advancePhase(st, "DRV-100", "R1", "at_pickup", &err));
    CHECK(advancePhase(st, "DRV-100", "R1", "on_trip", &err));
    CHECK(!advancePhase(st, "DRV-100", "R1", "arriving", &err)); // illegal backwards move
    double before = d->earnings;
    int trips = d->trips;
    CHECK(advancePhase(st, "DRV-100", "R1", "completed", &err));
    CHECK(st.ride("R1")->status == "completed");
    CHECK(near(d->earnings, before + st.ride("R1")->fare * 0.8, 0.02));
    CHECK(d->trips == trips + 1);
    CHECK(d->status == "online");
}

static void testRejectAndCancel() {
    AppState st = seedState();
    st.rides.clear();
    for (auto& a : st.accounts) if (a.role == "driver") a.status = "offline";
    mkRide(st, "C1", "Manila", 1000);
    Account* d = st.account("DRV-100");
    d->status = "online";

    std::string err;
    CHECK(offerRide(st, *st.ride("C1"), &err) != nullptr);
    CHECK(rejectRide(st, "DRV-100", "C1", &err));
    CHECK(st.ride("C1")->status == "pending");
    CHECK(st.ride("C1")->driverId.empty());
    CHECK(d->status == "online");

    CHECK(cancelRide(st, "C1", &err));
    CHECK(st.ride("C1")->status == "cancelled");
    CHECK(!cancelRide(st, "C1", &err)); // already cancelled
}

static void testServeNextAndSimulation() {
    AppState st = seedState();
    for (auto& a : st.accounts) if (a.role == "driver") a.status = "online";
    st.rides.clear();
    mkRide(st, "S1", "Makati", 1000);
    std::string msg = serveNext(st);
    CHECK(msg.rfind("Offered", 0) == 0);

    std::string sim = simulate(st, 6, true);
    CHECK(sim.find("Simulated 6 ticks") != std::string::npos);
    CHECK(st.tick > 0);
    bool foundPending = false;
    for (const auto& r : st.rides) if (r.status == "pending") foundPending = true;
    CHECK(foundPending || !st.rides.empty());
}

static void testDemoAdvance() {
    AppState st = seedState();
    st.rides.clear();
    for (auto& a : st.accounts) if (a.role == "driver") a.status = "offline";
    mkRide(st, "D1", "Manila", 1000);

    std::string msg;
    Ride* ride = demoAdvance(st, "D1", &msg);
    CHECK(ride && ride->status == "offered");
    CHECK(ride && !ride->driverId.empty());

    demoAdvance(st, "D1", &msg);
    CHECK(st.ride("D1")->status == "arriving");
    demoAdvance(st, "D1", &msg);
    CHECK(st.ride("D1")->status == "on_trip");
    demoAdvance(st, "D1", &msg);
    CHECK(st.ride("D1")->status == "completed");
    CHECK(st.account(st.ride("D1")->driverId)->earnings > 0);

    // advancing a closed ride is a no-op
    demoAdvance(st, "D1", &msg);
    CHECK(st.ride("D1")->status == "completed");
}

// ---------------------------------------------------------------------------
//  PERSISTENCE
// ---------------------------------------------------------------------------
static void testPersistenceRoundtrip() {
    AppState st = seedState();
    Json disk = stateToDisk(st);
    AppState back = stateFromDisk(Json::parse(disk.dump()));
    CHECK(back.accounts.size() == st.accounts.size());
    CHECK(back.routes.size() == st.routes.size());
    CHECK(back.locations.size() == st.locations.size());
    CHECK(back.settings.baseFare == st.settings.baseFare);
    CHECK(back.ui.at("brand.tagline") == st.ui.at("brand.tagline"));
    CHECK(back.account("DRV-100") != nullptr);
    CHECK(back.account("DRV-100")->plate == "NCR 2841");
}

static void testStats() {
    AppState st = seedState();
    Json s = statsJson(st);
    CHECK(s.at("totalRides").asInt() >= 1);
    CHECK(s.at("completed").asInt() >= 1);
    CHECK(s.at("drivers").asInt() == 4);
    CHECK(s.at("revenue").asDouble() > 0);
    CHECK(s.at("completionRate").asDouble() >= 0);
}

int main() {
    testJson();
    testFare();
    testQueueKeys();
    testQueueAndDispatch();
    testRejectAndCancel();
    testServeNextAndSimulation();
    testDemoAdvance();
    testPersistenceRoundtrip();
    testStats();

    std::cout << "\n" << g_pass << " passed, " << g_fail << " failed\n";
    return g_fail == 0 ? 0 : 1;
}
