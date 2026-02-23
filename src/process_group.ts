import { Transport } from "./transport";
import { Cluster } from "./cluster";
import { createLogger, Logger } from "./logger";

export interface GroupMember {
  nodeId: string;
  actorId: string;
  name?: string;
}

interface ProcessGroupUpdate {
  type: "join" | "leave";
  group: string;
  member: GroupMember;
}

export class ProcessGroupManager {
  private readonly groups = new Map<string, Map<string, GroupMember>>();
  private readonly log: Logger;

  constructor(
    private readonly nodeId: string,
    private readonly transport: Transport,
    cluster: Cluster,
  ) {
    this.log = createLogger("ProcessGroupManager", nodeId);

    if (cluster.on) {
      cluster.on("member_leave", this.handlePeerLeave.bind(this));
      cluster.on("member_join", this.handlePeerJoin.bind(this));
    }
  }

  async connect(): Promise<void> {
    await this.transport.subscribe("pg:updates", this.handleUpdate.bind(this));
  }

  async disconnect(): Promise<void> {
    this.groups.clear();
  }

  join(group: string, member: GroupMember): void {
    let members = this.groups.get(group);
    if (!members) {
      members = new Map();
      this.groups.set(group, members);
    }
    members.set(member.actorId, member);

    this.transport.publish("pg:updates", {
      type: "join",
      group,
      member,
    } satisfies ProcessGroupUpdate);

    this.log.debug("Actor joined group", { group, actorId: member.actorId });
  }

  leave(group: string, actorId: string): void {
    const members = this.groups.get(group);
    if (!members) return;

    const member = members.get(actorId);
    if (!member) return;

    members.delete(actorId);
    if (members.size === 0) {
      this.groups.delete(group);
    }

    this.transport.publish("pg:updates", {
      type: "leave",
      group,
      member,
    } satisfies ProcessGroupUpdate);

    this.log.debug("Actor left group", { group, actorId });
  }

  leaveAll(actorId: string): void {
    for (const [group, members] of this.groups) {
      const member = members.get(actorId);
      if (member) {
        members.delete(actorId);
        if (members.size === 0) {
          this.groups.delete(group);
        }
        this.transport.publish("pg:updates", {
          type: "leave",
          group,
          member,
        } satisfies ProcessGroupUpdate);
      }
    }
  }

  getMembers(group: string): GroupMember[] {
    const members = this.groups.get(group);
    if (!members) return [];
    return Array.from(members.values());
  }

  getGroups(): string[] {
    return Array.from(this.groups.keys());
  }

  private handleUpdate(message: any): void {
    const update = message as ProcessGroupUpdate;

    if (update.type === "join") {
      if (update.member.nodeId === this.nodeId) return;

      let members = this.groups.get(update.group);
      if (!members) {
        members = new Map();
        this.groups.set(update.group, members);
      }
      members.set(update.member.actorId, update.member);
      this.log.debug("Remote actor joined group", {
        group: update.group,
        actorId: update.member.actorId,
        nodeId: update.member.nodeId,
      });
    } else if (update.type === "leave") {
      if (update.member.nodeId === this.nodeId) return;

      const members = this.groups.get(update.group);
      if (members) {
        members.delete(update.member.actorId);
        if (members.size === 0) {
          this.groups.delete(update.group);
        }
      }
    }
  }

  private handlePeerLeave(nodeId: string): void {
    for (const [group, members] of this.groups) {
      const toRemove: string[] = [];
      for (const [actorId, member] of members) {
        if (member.nodeId === nodeId) {
          toRemove.push(actorId);
        }
      }
      for (const actorId of toRemove) {
        members.delete(actorId);
      }
      if (members.size === 0) {
        this.groups.delete(group);
      }
    }
    this.log.debug("Cleaned up groups for departed node", { nodeId });
  }

  private handlePeerJoin(_nodeId: string): void {
    for (const [group, members] of this.groups) {
      for (const member of members.values()) {
        if (member.nodeId === this.nodeId) {
          this.transport.publish("pg:updates", {
            type: "join",
            group,
            member,
          } satisfies ProcessGroupUpdate);
        }
      }
    }
  }
}
