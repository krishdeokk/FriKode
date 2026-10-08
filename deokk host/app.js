/**
 * FriKode Peer Collaboration Client Logic
 * Real-time event handler demo.
 */

class PeerSession {
  constructor(sessionId, hostIp) {
    this.sessionId = sessionId;
    this.hostIp = hostIp;
    this.collaborators = new Set();
  }

  registerCollaborator(name, color) {
    this.collaborators.add({ name, color, joinedAt: Date.now() });
    console.log(`[FriKode] Collaborator ${name} joined the room!`);
  }

  getActiveCount() {
    return this.collaborators.size;
  }
}

// Export for usage
export default PeerSession;
