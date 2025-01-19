'use client';

import { useEffect, useCallback } from 'react';
import { useWebSocket } from '../providers/websocket';

export function ExampleComponent() {
  const webSocketService = useWebSocket();

  // Memoize the handler to ensure consistent reference
  const handleMessage = useCallback((message: MessageEvent) => {
    console.log('Received message (2):', message.data);
  }, []);

  useEffect(() => {
    webSocketService.addMessageListener(handleMessage);
    return () => {
      webSocketService.removeMessageListener(handleMessage);
    };
  }, [webSocketService, handleMessage]);

  const sendMessage = useCallback(() => {
    webSocketService.send({ action: 'ping', content: 'Hello, WebSocket!' });
  }, [webSocketService]);

  return (
    <button onClick={sendMessage}>
      Send WebSocket Message
    </button>
  );
}