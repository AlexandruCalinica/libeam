// src/testing/index.ts
//
// Public API for libeam's testing utilities.

export { TestCluster } from "./test_cluster";
export type { TestNodeHandle, TestClusterConfig } from "./test_cluster";
export { allocatePorts } from "./port_allocator";
export type { NodePorts } from "./port_allocator";
export { FaultyTransport } from "./faulty_transport";
export { FaultyGossipUDP } from "./faulty_gossip";
