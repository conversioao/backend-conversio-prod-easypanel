import { Response } from 'express';

// Map: userId → Set of SSE response objects for WhatsApp Agent CRM
const agentSseClients = new Map<string, Set<Response>>();

export const agentRealtimeService = {
  addClient(userId: string, res: Response) {
    if (!agentSseClients.has(userId)) {
      agentSseClients.set(userId, new Set());
    }
    agentSseClients.get(userId)!.add(res);
  },

  removeClient(userId: string, res: Response) {
    const clients = agentSseClients.get(userId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        agentSseClients.delete(userId);
      }
    }
  },

  pushEvent(userId: string, event: { type: string; [key: string]: any }) {
    const clients = agentSseClients.get(userId);
    if (!clients || clients.size === 0) return;

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    clients.forEach(client => {
      try {
        client.write(payload);
      } catch (err) {
        console.error(`[AgentRealtime] Error pushing to client for user ${userId}:`, err);
      }
    });
  }
};
