package com.perpetual.eventbus.core;

import com.perpetual.eventbus.model.RoomEvent;
import java.util.concurrent.CompletableFuture;

/**
 * Enterprise Event Publisher Contract.
 * Provides both non-blocking reactive dispatch and asynchronous future completion.
 */
public interface EventPublisher {
    
    /**
     * Publishes event asynchronously. Returns CompletableFuture resolving when delivered to ring buffer.
     */
    CompletableFuture<Void> publishAsync(RoomEvent event);

    /**
     * Synchronous blocking publish for deterministic transactional boundaries.
     */
    void publishSync(RoomEvent event);
}
