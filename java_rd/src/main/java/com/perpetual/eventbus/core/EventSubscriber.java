package com.perpetual.eventbus.core;

import com.perpetual.eventbus.model.RoomEvent;

/**
 * Enterprise Subscriber Contract.
 * Defines subscription pattern, wildcard topic filter, and event handler.
 */
public interface EventSubscriber {

    /**
     * Unique identifier for subscriber registration & metrics.
     */
    String getSubscriberId();

    /**
     * Ant-style topic pattern matcher (e.g. "TASK_*", "DRIVE.**", "ORDER.*").
     */
    String getTopicPattern();

    /**
     * Predicate evaluating whether event matches subscription topic filter.
     */
    default boolean matches(String topic) {
        String pattern = getTopicPattern();
        if ("*".equals(pattern) || "**".equals(pattern) || "ALL".equalsIgnoreCase(pattern)) {
            return true;
        }
        if (pattern.endsWith("*")) {
            String prefix = pattern.substring(0, pattern.length() - 1);
            return topic != null && topic.startsWith(prefix);
        }
        return pattern.equalsIgnoreCase(topic);
    }

    /**
     * Invoked when matching event is dispatched by Event Bus.
     */
    void onEvent(RoomEvent event) throws Exception;

    /**
     * Invoked when event handling fails; enables Dead Letter Queue routing.
     */
    default void onError(RoomEvent event, Throwable throwable) {
        System.err.printf("[Subscriber %s Error] Failed on event %s: %s%n",
                getSubscriberId(), event.eventId(), throwable.getMessage());
    }
}
