class WebSocketService {
  private static instance: WebSocketService;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private performanceMonitor: NodeJS.Timeout | null = null;
  private messageQueue: (string | object)[] = [];
  private listeners: Set<(event: MessageEvent) => void> = new Set();
  private reconnectCount = 0;
  private missedPings = 0;
  private lastPongTime: number = Date.now();
  private lastMessageTime: number = Date.now();
  private connectionStartTime: number = 0;
  private isInitialized = false;
  private isReconnecting = false;
  private messagesSent = 0;
  private messagesReceived = 0;
  private bytesTransferred = 0;
  private lastPerformanceCheck = Date.now();
  private connectionQuality: "good" | "poor" | "degraded" = "good";

  private HEALTH_CHECK_INTERVAL = 30000;
  private HEALTH_CHECK_TIMEOUT = 5000;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_INTERVAL = 3000;
  private readonly MAX_MISSED_PINGS = 2;
  private readonly MAX_QUEUE_SIZE = 100;
  private readonly MAX_MESSAGE_SIZE = 1024 * 1024;
  private readonly MAX_BACKOFF_DELAY = 30000;
  private readonly ZOMBIE_CONNECTION_TIMEOUT = 90000;
  private readonly RATE_LIMIT_RESET = 60000;
  private readonly MAX_RATE_LIMIT_ATTEMPTS = 10;
  private readonly PERFORMANCE_CHECK_INTERVAL = 60000;
  private readonly MAX_MEMORY_USAGE = 230 * 1024 * 1024;

  private rateLimitCounter = {
    timestamp: Date.now(),
    count: 0,
  };

  private txBytes = 0;
  private rxBytes = 0;
  private txCount = 0;
  private rxCount = 0;

  private performanceMetrics = {
    latency: 0,
    messageRate: 0,
    failureRate: 0,
    lastFailureTime: 0,
    memoryUsage: 0,
  };

  private memoryUsageBreakdown = {
    messages: 0,
    listeners: 0,
    queue: 0,
    metrics: 0,
    other: 0,
  };

  private memoryLeakDetection = {
    lastMemoryUsage: 0,
    checkCount: 0,
    increasingCount: 0,
  };

  private log(message: string, type: "info" | "warn" | "error" = "info") {
    const date = new Date();
    const timestamp = date
      .toLocaleString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
      .replace(",", "");
    const prefix = `\x1b[90m[\x1b[95mWebSocket\x1b[90m] [\x1b[37m${timestamp}\x1b[90m]\x1b[0m:`;

    switch (type) {
      case "warn":
        console.warn(`${prefix} ${message}`);
        break;
      case "error":
        console.error(`${prefix} ${message}`);
        break;
      default:
        console.log(`${prefix} ${message}`);
    }
  }

  private constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.handleNetworkChange(true));
      window.addEventListener("offline", () => this.handleNetworkChange(false));
      window.addEventListener("focus", () => this.handleWindowFocus());
      window.addEventListener("beforeunload", () => this.cleanupConnection());
      document.addEventListener("visibilitychange", () =>
        this.handleVisibilityChange()
      );

      if ("connection" in navigator) {
        (navigator as any).connection?.addEventListener("change", () =>
          this.handleNetworkQualityChange()
        );
      }

      this.startPerformanceMonitoring();
      setInterval(() => this.periodicCleanup(), 5 * 60 * 1000);
    }
  }

  private debugMemoryUsage() {
    this.log(`Debug Memory Information:
      - WebSocket Buffer Size: ${this.ws?.bufferedAmount || 0} bytes
      - Message Queue Items: ${this.messageQueue.length}
      - Listener Types: ${Array.from(this.listeners)
        .map((l) => l.name || "anonymous")
        .join(", ")}
      - Last Message Time: ${new Date(this.lastMessageTime).toISOString()}
      - Connection Duration: ${(
        (Date.now() - this.connectionStartTime) /
        1000
      ).toFixed(0)}s
    `);
  }

  private periodicCleanup() {
    // Clear any stored message data
    this.bytesTransferred = 0;
    this.messagesSent = 0;
    this.messagesReceived = 0;
    this.txBytes = 0;
    this.rxBytes = 0;
    this.txCount = 0;
    this.rxCount = 0;

    // Force garbage collection of metrics
    this.performanceMetrics = {
      latency: 0,
      messageRate: 0,
      failureRate: 0,
      lastFailureTime: 0,
      memoryUsage: 0,
    };

    this.log(
      `Periodic cleanup completed. Current listeners: ${this.listeners.size}`
    );
  }

  public static getInstance(): WebSocketService {
    if (!WebSocketService.instance) {
      WebSocketService.instance = new WebSocketService();
    }
    return WebSocketService.instance;
  }

  private checkForMemoryLeaks() {
    const currentMemory = this.getMemoryUsage();

    if (currentMemory > this.memoryLeakDetection.lastMemoryUsage) {
      this.memoryLeakDetection.increasingCount++;

      if (this.memoryLeakDetection.increasingCount >= 5) {
        this.log(
          `Potential memory leak detected! Memory has increased ${this.memoryLeakDetection.increasingCount} times in a row.`,
          "warn"
        );
        this.debugMemoryUsage();
      }
    } else {
      this.memoryLeakDetection.increasingCount = 0;
    }

    this.memoryLeakDetection.lastMemoryUsage = currentMemory;
    this.memoryLeakDetection.checkCount++;
  }

  private startPerformanceMonitoring() {
    this.performanceMonitor = setInterval(() => {
      this.checkPerformance();
      this.checkForMemoryLeaks();
    }, this.PERFORMANCE_CHECK_INTERVAL);
  }

  private checkPerformance() {
    const now = Date.now();
    const timeDiff = (now - this.lastPerformanceCheck) / 1000;

    this.performanceMetrics.messageRate =
      (this.txCount + this.rxCount) / timeDiff;
    this.performanceMetrics.memoryUsage = this.getMemoryUsage();

    if (this.performanceMetrics.memoryUsage > this.MAX_MEMORY_USAGE) {
      this.log(
        "Memory usage exceeded threshold, cleaning up resources",
        "warn"
      );
      this.cleanupResources();
    }

    this.txCount = 0;
    this.rxCount = 0;
    this.lastPerformanceCheck = now;

    this.logPerformanceReport();
  }

  private getMemoryUsage(): number {
    if ("memory" in performance) {
      return (performance as any).memory.usedJSHeapSize;
    }
    return 0;
  }

  private cleanupResources() {
    if (this.messageQueue.length > this.MAX_QUEUE_SIZE / 2) {
      this.messageQueue = this.messageQueue.slice(-this.MAX_QUEUE_SIZE / 2);
      this.log("Message queue trimmed due to memory constraints", "warn");
    }

    if (this.listeners.size > 100) {
      this.log("Too many listeners detected, consider cleaning up", "warn");
    }
  }

  private logPerformanceReport() {
    const memoryInfo = (performance as any).memory || {};
    const totalBefore = this.getMemoryUsage();
    const uptimeSeconds = (Date.now() - this.connectionStartTime) / 1000;
    const uptimeFormatted = `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${Math.floor(uptimeSeconds % 60)}s`;

    // Reset breakdown before measuring
    this.memoryUsageBreakdown = {
      messages: 0,
      listeners: 0,
      queue: 0,
      metrics: 0,
      other: 0,
    };

    // Measure message queue size
    this.memoryUsageBreakdown.queue = this.messageQueue.reduce(
      (size, msg) =>
        size +
        (typeof msg === "string"
          ? msg.length * 2
          : JSON.stringify(msg).length * 2),
      0
    );

    // Measure listeners
    this.memoryUsageBreakdown.listeners = this.listeners.size * 1024; // Rough estimate per listener

    // Measure metrics storage
    this.memoryUsageBreakdown.metrics =
      JSON.stringify(this.performanceMetrics).length * 2;

    // Calculate other memory usage
    const measuredMemory = Object.values(this.memoryUsageBreakdown).reduce(
      (a, b) => a + b,
      0
    );
    this.memoryUsageBreakdown.other = totalBefore - measuredMemory;

    this.log(`Performance Report:
      Uptime: ${uptimeFormatted}
      Message Rate: ${this.performanceMetrics.messageRate.toFixed(2)}/s
      TX Stats: ${(this.txBytes / 1024).toFixed(2)}KB (${this.txCount} messages)
      RX Stats: ${(this.rxBytes / 1024).toFixed(2)}KB (${this.rxCount} messages)
      Memory Usage: ${(this.performanceMetrics.memoryUsage / 1024 / 1024).toFixed(2)}MB
      Heap Size Limit: ${(memoryInfo.jsHeapSizeLimit / 1024 / 1024).toFixed(2)}MB
      Total Heap Size: ${(memoryInfo.totalJSHeapSize / 1024 / 1024).toFixed(2)}MB
      Used Heap Size: ${(memoryInfo.usedJSHeapSize / 1024 / 1024).toFixed(2)}MB
      Message Queue Length: ${this.messageQueue.length}
      Listener Count: ${this.listeners.size}
      Memory Breakdown:
        - Messages: ${(this.memoryUsageBreakdown.messages / 1024 / 1024).toFixed(2)}MB
        - Listeners: ${(this.memoryUsageBreakdown.listeners / 1024 / 1024).toFixed(2)}MB
        - Queue: ${(this.memoryUsageBreakdown.queue / 1024 / 1024).toFixed(2)}MB
        - Metrics: ${(this.memoryUsageBreakdown.metrics / 1024 / 1024).toFixed(2)}MB
        - Other/Unknown: ${(this.memoryUsageBreakdown.other / 1024 / 1024).toFixed(2)}MB
    `);

    // Log warning if unknown memory usage is high
    if (this.memoryUsageBreakdown.other > 230 * 1024 * 1024) {
      // More than 50MB
      this.log(
        `Warning: High unaccounted memory usage: ${(
          this.memoryUsageBreakdown.other /
          1024 /
          1024
        ).toFixed(2)}MB`,
        "warn"
      );
    }
  }

  private handleNetworkQualityChange() {
    const connection = (navigator as any).connection;
    const effectiveType = connection?.effectiveType;
    const downlink = connection?.downlink;

    this.log(
      `Network quality changed: ${effectiveType}, Downlink: ${downlink}Mbps`
    );

    if (
      effectiveType === "slow-2g" ||
      effectiveType === "2g" ||
      downlink < 0.5
    ) {
      this.adjustForPoorConnection();
    } else if (downlink > 1.5) {
      this.adjustForGoodConnection();
    }
  }

  private adjustForPoorConnection() {
    this.connectionQuality = "poor";
    this.HEALTH_CHECK_INTERVAL = 45000;
    this.HEALTH_CHECK_TIMEOUT = 10000;
    this.log("Adjusted for poor connection", "warn");
  }

  private adjustForGoodConnection() {
    this.connectionQuality = "good";
    this.HEALTH_CHECK_INTERVAL = 30000;
    this.HEALTH_CHECK_TIMEOUT = 5000;
    this.log("Adjusted for good connection");
  }

  private handleNetworkChange(isOnline: boolean) {
    if (isOnline) {
      this.log("Network online, attempting reconnect...");
      this.reconnect();
    } else {
      this.log("Network offline, disconnecting...", "warn");
      this.disconnect();
    }
  }

  private handleWindowFocus() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log("Window focused, checking connection...");
      this.checkZombieConnection();
    }
  }

  private handleVisibilityChange() {
    if (document.visibilityState === "visible") {
      this.checkZombieConnection();
    }
  }

  private checkZombieConnection() {
    if (
      this.ws?.readyState === WebSocket.OPEN &&
      Date.now() - this.lastMessageTime > this.ZOMBIE_CONNECTION_TIMEOUT
    ) {
      this.log("Zombie connection detected, reconnecting...", "warn");
      this.reconnect();
    }
  }

  private calculateBackoffDelay(): number {
    return Math.min(
      this.RECONNECT_INTERVAL * Math.pow(1.5, this.reconnectCount),
      this.MAX_BACKOFF_DELAY
    );
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    if (now - this.rateLimitCounter.timestamp > this.RATE_LIMIT_RESET) {
      this.rateLimitCounter = { timestamp: now, count: 0 };
    }

    if (this.rateLimitCounter.count >= this.MAX_RATE_LIMIT_ATTEMPTS) {
      this.log("Rate limit exceeded for reconnection attempts", "error");
      return false;
    }

    this.rateLimitCounter.count++;
    return true;
  }

  public connect() {
    if (this.isReconnecting || this.ws?.readyState === WebSocket.OPEN) return;
    if (typeof window === "undefined") return;
    if (!this.checkRateLimit()) return;

    try {
      this.ws = new WebSocket("wss://chat.caseduel.com");
      this.connectionStartTime = Date.now();
      this.isReconnecting = true;
      this.isInitialized = true;

      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = this.handleOpen.bind(this);
      this.ws.onclose = this.handleClose.bind(this);
      this.ws.onerror = this.handleError.bind(this);
      this.ws.onmessage = this.handleMessage.bind(this);
    } catch (error) {
      this.log(`WebSocket construction failed: ${error}`, "error");
      this.handleError(error as Event);
    }
  }

  private handleOpen() {
    this.log("Connection established");
    this.isReconnecting = false;
    this.reconnectCount = 0;
    this.missedPings = 0;
    this.lastPongTime = Date.now();
    this.lastMessageTime = Date.now();
    this.startHealthChecks();
    this.processMessageQueue();
  }

  private handleClose(event: CloseEvent) {
    const connectionDuration = Date.now() - this.connectionStartTime;
    this.log(
      `Connection closed after ${connectionDuration}ms. Code: ${event.code}, Reason: ${event.reason}`,
      "warn"
    );
    this.stopHealthChecks();
    this.isReconnecting = false;
    this.attemptReconnect();
  }

  private handleError(error: Event) {
    this.log(`Connection error: ${error}`, "error");
    this.isReconnecting = false;
  }

  private handleMessage(message: MessageEvent) {
    const messageSize = this.getMessageSize(message.data);
    if (messageSize > 1024 * 1024) {
      // If > 1MB
      this.log(
        `Large message received: ${(messageSize / 1024 / 1024).toFixed(2)}MB`,
        "warn"
      );
    }
    this.lastMessageTime = Date.now();
    this.rxCount++;
    this.rxBytes += this.getMessageSize(message.data);
    this.messagesReceived++;
    this.bytesTransferred += this.getMessageSize(message.data);
    const beforeSize = this.getMemoryUsage();

    try {
      if (message.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(message.data);
        return;
      }

      const data =
        typeof message.data === "string"
          ? JSON.parse(message.data)
          : message.data;

      if (data.action === "pong") {
        this.handlePong();
        return;
      }

      this.notifyListeners(message);
    } catch (error) {
      this.log(`Error processing message: ${error}`, "error");
      this.performanceMetrics.failureRate++;
    }

    const afterSize = this.getMemoryUsage();
    this.memoryUsageBreakdown.messages += afterSize - beforeSize;

    // Add memory tracking to log
    if (afterSize - beforeSize > 1024 * 1024) {
      // If message consumed more than 1MB
      this.log(
        `Large message received: ${(
          (afterSize - beforeSize) /
          1024 /
          1024
        ).toFixed(2)}MB`,
        "warn"
      );
    }
  }

  private handleBinaryMessage(data: ArrayBuffer) {
    this.log(`Received binary message of size: ${data.byteLength}`);
  }

  private handlePong() {
    this.lastPongTime = Date.now();
    this.missedPings = 0;
    this.log("Pong received, connection healthy");
  }

  private startHealthChecks() {
    this.stopHealthChecks();
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.HEALTH_CHECK_INTERVAL);
  }

  private performHealthCheck() {
    const timeSinceLastPong = Date.now() - this.lastPongTime;

    if (timeSinceLastPong > this.HEALTH_CHECK_TIMEOUT) {
      this.missedPings++;
      this.log(
        `Missed ping response. Strike ${this.missedPings}/${this.MAX_MISSED_PINGS}`,
        "warn"
      );

      if (this.missedPings >= this.MAX_MISSED_PINGS) {
        this.log("Connection degraded, initiating reconnect...", "error");
        this.reconnect();
        return;
      }
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.log("Sending ping...");
      this.send({ action: "ping" });
    }
  }

  private stopHealthChecks() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private attemptReconnect() {
    if (this.reconnectCount < this.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectCount++;
      const delay = this.calculateBackoffDelay();
      this.reconnectTimer = setTimeout(() => {
        this.log(`Reconnecting... Attempt ${this.reconnectCount}`);
        this.connect();
      }, delay);
    }
  }

  public reconnect() {
    this.disconnect();
    this.reconnectCount = 0;
    this.connect();
  }

  public disconnect() {
    this.stopHealthChecks();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private getMessageSize(data: any): number {
    if (typeof data === "string") {
      return data.length * 2; // UTF-16 encoding
    }
    if (data instanceof ArrayBuffer) {
      return data.byteLength;
    }
    return JSON.stringify(data).length * 2;
  }

  public send(message: string | object) {
    const messageStr =
      typeof message === "string" ? message : JSON.stringify(message);

    if (messageStr.length > this.MAX_MESSAGE_SIZE) {
      this.log("Message exceeds maximum size limit", "error");
      return;
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(messageStr);
        this.txCount++;
        this.txBytes += this.getMessageSize(messageStr);
      } catch (error) {
        this.log(`Error sending message: ${error}`, "error");
        this.queueMessage(message);
      }
    } else {
      this.queueMessage(message);
    }
  }

  private queueMessage(message: string | object) {
    if (this.messageQueue.length < this.MAX_QUEUE_SIZE) {
      this.messageQueue.push(message);
    } else {
      this.log("Message queue overflow, dropping message", "warn");
    }
  }

  private processMessageQueue() {
    while (
      this.messageQueue.length > 0 &&
      this.ws?.readyState === WebSocket.OPEN
    ) {
      const message = this.messageQueue.shift();
      if (message) this.send(message);
    }
  }

  private cleanupConnection() {
    this.stopPerformanceMonitoring();
    this.disconnect();
  }

  private stopPerformanceMonitoring() {
    if (this.performanceMonitor) {
      clearInterval(this.performanceMonitor);
      this.performanceMonitor = null;
    }
  }
  public addMessageListener(listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }

  public removeMessageListener(listener: (event: MessageEvent) => void) {
    this.listeners.delete(listener);
  }

  private notifyListeners(message: MessageEvent) {
    this.listeners.forEach((listener) => {
      try {
        listener(message);
      } catch (error) {
        this.log(`Error in message listener: ${error}`, "error");
      }
    });
  }

  public getConnectionState(): number | undefined {
    return this.ws?.readyState;
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  public getPerformanceMetrics() {
    return {
      ...this.performanceMetrics,
      connectionQuality: this.connectionQuality,
      messageQueueSize: this.messageQueue.length,
      txBytes: this.txBytes,
      rxBytes: this.rxBytes,
      txCount: this.txCount,
      rxCount: this.rxCount,
      uptime: this.connectionStartTime ? Date.now() - this.connectionStartTime : 0,
    };
  }
}

export const webSocketService = WebSocketService.getInstance();
