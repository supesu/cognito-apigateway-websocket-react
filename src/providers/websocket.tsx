"use client";

import { createContext, useContext, useEffect, ReactNode } from "react";
import { webSocketService } from "@/services/websocket";

const WebSocketContext = createContext<typeof webSocketService | null>(null);

export const WebSocketProvider = ({ children }: { children: ReactNode }) => {
  useEffect(() => {
    // Only connect if not already connected
    if (!webSocketService.isConnected()) {
      webSocketService.connect();
    }

    return () => {
      webSocketService.disconnect();
    };
  }, []);

  return (
    <WebSocketContext.Provider value={webSocketService}>
      {children}
    </WebSocketContext.Provider>
  );
};

// Custom hook to use WebSocket in components
export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error("useWebSocket must be used within a WebSocketProvider");
  }
  return context;
};
