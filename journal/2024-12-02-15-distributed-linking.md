# Entry 15: Distributed Actor Linking

## Project Timeline

- **Entry 1**: Decentralized registry with gossip protocol
- **Entry 2**: Cleanup and ZeroMQ transport testing
- **Entry 3**: Graceful shutdown implementation
- **Entry 4**: Structured logging and error handling
- **Entry 5**: Health checks for actor system components
- **Entry 6**: Basic supervision trees (parent-child)
- **Entry 7**: Child supervision strategies (one-for-one, one-for-all, rest-for-one)
- **Entry 8**: Actor watching (monitoring termination)
- **Entry 9**: Message stashing (deferred processing)
- **Entry 10**: Typed actors with generics
- **Entry 11**: Unified typed API
- **Entry 12**: Distributed actor refs via registry lookup
- **Entry 13**: Core OTP features - timers, handleContinue, links, idle timeout
- **Entry 14**: Distributed actor watching
- **Entry 15 (Current)**: Distributed actor linking

## Current State

### All Examples Passing

All 12 examples run successfully including the new distributed linking example.

### Features Complete

Distributed linking is now fully implemented with:
- Remote link setup via RPC
- Bidirectional crash propagation across nodes
- `trapExit` support for remote links
- Node failure handling for links

## Architecture

### Protocol Design

```
Node A (linker)                     Node B (linked)
┌─────────────────┐                ┌─────────────────┐
│  ActorA         │                │  ActorB         │
│       │         │                │       │         │
│   link(B)       │                │                 │
│       │         │                │                 │
│       ▼         │   RPC request  │                 │
│  ActorSystem ───┼───────────────►│  ActorSystem    │
│  (remote link)  │  "link:add"    │  stores linker  │
│                 │                │  info           │
│                 │                │       │         │
│  ◄──────────────┼────────────────┤  actor crashes  │
│  receives EXIT  │  "link:exit"   │  notifies all   │
│  or crashes     │                │  remote linkers │
└─────────────────┘                └─────────────────┘
```

### New RPC Message Types

```typescript
// Sent from linker's node to linked actor's node
type LinkAddRequest = {
  type: "link:add";
  linkRefId: string;
  linkerNodeId: string;
  linkerActorId: string;
  linkedActorId: string;
  trapExit: boolean;  // Whether linker traps exits
};

// Response from linked actor's node
type LinkAddResponse = {
  success: boolean;
  alreadyDead?: boolean;
};

// Sent when linked actor exits
type LinkExitNotification = {
  type: "link:exit";
  linkRefId: string;
  exitedActorId: string;
  reason: TerminationReason;
};

// Sent to remove a remote link
type LinkRemoveRequest = {
  type: "link:remove";
  linkRefId: string;
  linkedActorId: string;
};
```

### Key Data Structures

```typescript
// On linked actor's node - tracks who is linked to local actors
interface RemoteLinkerInfo {
  linkRefId: string;
  linkerNodeId: string;
  linkerActorId: string;
  trapExit: boolean;
}

// Map: linkedActorId -> Set<RemoteLinkerInfo>
private remoteLinkers = new Map<string, Set<RemoteLinkerInfo>>();

// On linker's node - tracks remote actors being linked to
interface RemoteLinkEntry {
  linkRef: LinkRef;
  localActorRef: ActorRef;
  remoteNodeId: string;
  remoteActorId: string;
}

// Map: linkRefId -> RemoteLinkEntry
private remoteLinks = new Map<string, RemoteLinkEntry>();
```

## Key Implementation Details

### link() Method Enhancement

The `link()` method now detects if the target actor is remote:

```typescript
link(actor1Ref: ActorRef, actor2Ref: ActorRef): LinkRef {
  const actor2NodeId = actor2Ref.id.systemId;
  const isRemote = actor2NodeId !== this.id;

  if (isRemote) {
    return this._setupRemoteLink(actor1Ref, actor2Ref, actor1);
  }
  // ... local link logic
}
```

### Remote Exit Handling

When a remote linked actor exits, the local actor either:
1. **Crashes** (if `trapExit=false` and reason is abnormal)
2. **Receives ExitMessage** (if `trapExit=true`)

```typescript
private _handleRemoteLinkExit(notification): void {
  // ... cleanup remote link tracking ...
  
  if (localActor.context.trapExit) {
    // Send ExitMessage via handleInfo
    localActor.handleInfo(exitMessage);
  } else if (reason.type === "error" || reason.type === "killed") {
    // Crash the local actor
    this.supervisor.handleCrash(localActorRef, linkedError);
  }
}
```

### Node Failure Handling

Updated `handleNodeFailure()` to handle both watches and links:

```typescript
handleNodeFailure(deadNodeId: string): void {
  // Handle remote watches (existing)
  this._handleNodeFailureForWatches(deadNodeId);
  
  // Handle remote links (new)
  this._handleNodeFailureForLinks(deadNodeId);
}
```

## Location Transparency

All operations are location-transparent - the developer doesn't need to know if an actor is local or remote:

| Operation | Location Check | Local Path | Remote Path |
|-----------|---------------|------------|-------------|
| `cast()` | `actorId.systemId === this.id` | Push to mailbox | `transport.send()` |
| `call()` | `actorId.systemId === this.id` | Push to mailbox | `transport.request()` |
| `watch()` | `watchedRef.id.systemId !== this.id` | Store in `watches` | Send `watch:add` RPC |
| `link()` | `actor2Ref.id.systemId !== this.id` | Store in `links` | Send `link:add` RPC |
| `unwatch()` | Check `remoteWatches` first | Delete from `watches` | Send `watch:remove` |
| `unlink()` | Check `remoteLinks` first | Delete from `links` | Send `link:remove` |

The key is `ActorRef.id.systemId` - it contains the node ID where the actor lives, enabling automatic routing decisions.

## Files Modified

| File | Changes |
|------|---------|
| `src/actor_system.ts` | Added `RemoteLinkerInfo`, `RemoteLinkEntry` interfaces; `remoteLinkers`, `remoteLinks` maps; `_setupRemoteLink()`, `_unlinkRemote()`, `_notifyRemoteLinkers()`, `_notifyRemoteLinker()`, `_notifyRemoteLinkExit()`, `_handleRemoteLinkAdd()`, `_handleRemoteLinkRemove()`, `_handleRemoteLinkExit()`, `_handleNodeFailureForLinks()` methods; refactored `notifyLinkedActors()` and `handleNodeFailure()` |

## New Example

`examples/distributed_linking.ts` - Demonstrates:
- Basic remote link with crash propagation
- `trapExit` with remote links
- Graceful shutdown notification
- Node failure simulation

### Example Output Highlights

```
--- Demo 1: Basic Remote Linking (crash propagation) ---
  [Coordinator:C1] Linking to W1 on node2
  Crashing W1 (coordinator should crash too)...
  [W1] Crashing!
  [Coordinator:C1] Terminated
  Node1 actor count after crash: 0
  (Coordinator crashed due to linked worker crash)

--- Demo 2: Remote Link with trapExit ---
  [Supervisor:S1] Linking to W2 on node2
  Crashing W2 (supervisor traps exit)...
  [Supervisor:S1] Received EXIT from W2@node2: killed
  Supervisor still alive: true

--- Demo 4: Node Failure Simulation ---
  Simulating node2 failure...
  [Supervisor:S1] Received EXIT from W4@node2: killed
  [Supervisor:S1] Received EXIT from W5@node2: killed
```

## Next Steps

1. **Distributed Supervision** - Spawn and supervise children on remote nodes
2. **Heartbeat Protocol** - Automatic failure detection between nodes
3. **Actor Migration** - Move actors between nodes

## Commits This Session

1. `bd864b0` - Implement distributed actor linking
