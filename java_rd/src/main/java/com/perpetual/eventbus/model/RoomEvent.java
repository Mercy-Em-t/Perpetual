package com.perpetual.eventbus.model;

import java.io.Serializable;
import java.time.Instant;
import java.util.Collections;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Enterprise Immutable Event Record for Perpetual Shared Agent Room.
 * Enforces zero mutation, deterministic tracing, and serialization contracts.
 */
public record RoomEvent(
        String eventId,
        String sender,
        String target,
        String topic,
        Map<String, Object> payload,
        long epochMillis,
        String traceId
) implements Serializable {

    public RoomEvent {
        Objects.requireNonNull(topic, "Event topic cannot be null");
        Objects.requireNonNull(sender, "Event sender cannot be null");
        if (eventId == null || eventId.isBlank()) {
            eventId = "evt_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        }
        if (target == null || target.isBlank()) {
            target = "ALL";
        }
        if (payload == null) {
            payload = Collections.emptyMap();
        } else {
            payload = Collections.unmodifiableMap(payload);
        }
        if (epochMillis <= 0) {
            epochMillis = Instant.now().toEpochMilli();
        }
        if (traceId == null || traceId.isBlank()) {
            traceId = "trc_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        }
    }

    public static RoomEvent of(String sender, String topic, Map<String, Object> payload) {
        return new RoomEvent(null, sender, "ALL", topic, payload, 0, null);
    }

    public static RoomEvent of(String sender, String target, String topic, Map<String, Object> payload) {
        return new RoomEvent(null, sender, target, topic, payload, 0, null);
    }
}
