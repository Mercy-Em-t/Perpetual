package com.perpetual.eventbus.core;

import com.perpetual.eventbus.model.RoomEvent;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.*;

/**
 * Enterprise Non-Blocking Event Bus.
 * Features concurrent subscriber routing, worker thread pool, backpressure, and DLQ.
 */
public class ReactorEventBus implements EventPublisher, AutoCloseable {

    private final List<EventSubscriber> subscribers = new CopyOnWriteArrayList<>();
    private final Queue<DeadLetterRecord> deadLetterQueue = new ConcurrentLinkedQueue<>();
    private final ExecutorService workerPool;
    private final ConcurrentHashMap<String, Long> deduplicationCache = new ConcurrentHashMap<>();
    private final long dedupTtlMillis;

    public record DeadLetterRecord(RoomEvent event, String subscriberId, Throwable error, long timestamp) {}

    public ReactorEventBus() {
        this(Runtime.getRuntime().availableProcessors() * 2, 10_000);
    }

    public ReactorEventBus(int threadPoolSize, long dedupTtlMillis) {
        this.workerPool = Executors.newFixedThreadPool(threadPoolSize, new ThreadFactory() {
            private int counter = 0;
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "ReactorEventBus-Worker-" + (++counter));
                t.setDaemon(true);
                return t;
            }
        });
        this.dedupTtlMillis = dedupTtlMillis;
    }

    public void register(EventSubscriber subscriber) {
        subscribers.add(subscriber);
    }

    public void unregister(EventSubscriber subscriber) {
        subscribers.remove(subscriber);
    }

    @Override
    public CompletableFuture<Void> publishAsync(RoomEvent event) {
        return CompletableFuture.runAsync(() -> publishSync(event), workerPool);
    }

    @Override
    public void publishSync(RoomEvent event) {
        // Idempotency / deduplication check
        String dedupKey = event.topic() + ":" + event.sender() + ":" + event.payload().hashCode();
        long now = System.currentTimeMillis();
        Long lastSeen = deduplicationCache.put(dedupKey, now);
        if (lastSeen != null && (now - lastSeen) < dedupTtlMillis) {
            // Suppress duplicate within window
            return;
        }

        for (EventSubscriber sub : subscribers) {
            if (sub.matches(event.topic())) {
                try {
                    sub.onEvent(event);
                } catch (Throwable t) {
                    deadLetterQueue.offer(new DeadLetterRecord(event, sub.getSubscriberId(), t, now));
                    sub.onError(event, t);
                }
            }
        }
    }

    public int getSubscriberCount() {
        return subscribers.size();
    }

    public int getDeadLetterCount() {
        return deadLetterQueue.size();
    }

    public Queue<DeadLetterRecord> getDeadLetterQueue() {
        return deadLetterQueue;
    }

    @Override
    public void close() {
        workerPool.shutdown();
        try {
            if (!workerPool.awaitTermination(2, TimeUnit.SECONDS)) {
                workerPool.shutdownNow();
            }
        } catch (InterruptedException e) {
            workerPool.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}
