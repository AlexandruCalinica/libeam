// src/testing/port_allocator.ts
//
// Dynamic port allocation for test clusters. Uses the OS to find
// available ports by binding to port 0 and reading back the assigned port.

import * as net from "node:net";
import * as dgram from "node:dgram";

/**
 * Port set for a single libeam node (rpc, pub, gossip).
 * Convention: rpc=base, pub=base+1, gossip=base+2.
 */
export interface NodePorts {
  rpc: number;
  pub: number;
  gossip: number;
}

/**
 * Find a single available TCP port.
 * Creates a server on port 0, reads the OS-assigned port, then closes.
 */
function findTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to get TCP port"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/**
 * Check that a UDP port is available by binding and immediately releasing.
 */
function checkUdpPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    socket.unref();
    socket.bind(port, "127.0.0.1", () => {
      socket.close(() => resolve(true));
    });
    socket.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Allocate a set of 3 consecutive ports (rpc, pub, gossip) for a single node.
 * Finds a base TCP port, then verifies base+1 and base+2 are also available
 * (both TCP and UDP for the gossip port).
 */
async function allocateNodePorts(
  usedPorts: Set<number>,
  maxRetries = 20,
): Promise<NodePorts> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const rpc = await findTcpPort();

    // Skip if any of the 3 consecutive ports are already claimed
    const pub = rpc + 1;
    const gossip = rpc + 2;

    if (usedPorts.has(rpc) || usedPorts.has(pub) || usedPorts.has(gossip)) {
      continue;
    }

    // Verify pub port is available (TCP)
    const pubAvailable = await checkTcpPort(pub);
    if (!pubAvailable) continue;

    // Verify gossip port is available (UDP)
    const gossipAvailable = await checkUdpPort(gossip);
    if (!gossipAvailable) continue;

    // Claim all 3
    usedPorts.add(rpc);
    usedPorts.add(pub);
    usedPorts.add(gossip);

    return { rpc, pub, gossip };
  }

  throw new Error(
    `Failed to allocate 3 consecutive ports after ${maxRetries} attempts`,
  );
}

/**
 * Check that a TCP port is available by binding and immediately releasing.
 */
function checkTcpPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Allocate port sets for N nodes. Each node gets 3 consecutive ports.
 * All ports are guaranteed to be unique and available at allocation time.
 *
 * @param count Number of nodes to allocate ports for
 * @returns Array of NodePorts, one per node
 */
export async function allocatePorts(count: number): Promise<NodePorts[]> {
  const usedPorts = new Set<number>();
  const result: NodePorts[] = [];

  for (let i = 0; i < count; i++) {
    result.push(await allocateNodePorts(usedPorts));
  }

  return result;
}
