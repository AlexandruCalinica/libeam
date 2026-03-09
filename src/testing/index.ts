// src/testing/index.ts
//
// Public API for libeam's testing utilities.

export { TestCluster } from "./test_cluster.js";
export type { TestNodeHandle, TestClusterConfig } from "./test_cluster.js";
export { allocatePorts } from "./port_allocator.js";
export type { NodePorts } from "./port_allocator.js";
export { FaultyTransport } from "./faulty_transport.js";
export { FaultyGossipUDP } from "./faulty_gossip.js";
