package com.perpetual.eventbus.bridge;

import com.perpetual.eventbus.core.EventSubscriber;
import com.perpetual.eventbus.model.RoomEvent;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;

/**
 * Enterprise WhatsApp Bridge Subscriber.
 * Implements Observer pattern translating room domain events to formatted WhatsApp group cards.
 */
public class WhatsAppBridgeSubscriber implements EventSubscriber {

    private final String gatewayEndpoint;
    private final HttpClient httpClient;

    public WhatsAppBridgeSubscriber(String gatewayEndpoint) {
        this.gatewayEndpoint = gatewayEndpoint;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(3))
                .build();
    }

    @Override
    public String getSubscriberId() {
        return "WHATSAPP_DEPARTMENT_BRIDGE";
    }

    @Override
    public String getTopicPattern() {
        return "*"; // Subscribes to all events, routes internally by department
    }

    @Override
    public void onEvent(RoomEvent event) throws Exception {
        String topic = event.topic();
        Map<String, Object> payload = event.payload();

        // 1. Operational Events -> Floor Operations (perpetua)
        if (topic.startsWith("TASK_") || topic.startsWith("DRIVE_") || topic.startsWith("ORDER_")) {
            String title = (String) payload.getOrDefault("title", "Room Event: " + topic);
            String status = (String) payload.getOrDefault("new_state",
                    payload.getOrDefault("status", topic.replace("TASK_", "")));
            String taskId = (String) payload.get("task_id");

            String card = String.format("""
                    🚀 *[ROOM EVENT]* `%s`
                    ╭────────────────────────────────╮
                      • Topic: *%s*
                      • State: %s
                      • Sender: %s
                    ╰────────────────────────────────╯
                    _Trace: %s_""",
                    taskId != null ? taskId : event.eventId(),
                    topic, status, event.sender(), event.traceId()
            );

            dispatchToGateway("general", card);
        }

        // 2. Incident & Error Events -> IT Helpdesk
        if (topic.contains("ERROR") || topic.contains("TIMEOUT") || topic.contains("TICKET")) {
            String card = String.format("""
                    🚨 *[IT HELPDESK ALERT]*
                    ╭────────────────────────────────╮
                      • Incident: *%s*
                      • Sender: %s
                      • Trace ID: `%s`
                    ╰────────────────────────────────╯
                    _Desk engineers notified._""",
                    topic, event.sender(), event.traceId()
            );
            dispatchToGateway("itHelpdesk", card);
        }

        // 3. Executive Audit & Rollup -> Admin Oversight
        if (topic.contains("AUDIT") || topic.contains("PULSE") || topic.contains("REVENUE")) {
            String card = String.format("""
                    📊 *[EXECUTIVE OVERSIGHT]*
                    ╭────────────────────────────────╮
                      • Event: *%s*
                      • Actor: %s
                    ╰────────────────────────────────╯
                    _Audit trail committed._""",
                    topic, event.sender()
            );
            dispatchToGateway("adminOversight", card);
        }
    }

    private void dispatchToGateway(String groupKey, String messageText) {
        try {
            String jsonPayload = String.format(
                    "{\"group\": \"%s\", \"message\": \"%s\"}",
                    groupKey,
                    messageText.replace("\"", "\\\"").replace("\n", "\\n")
            );

            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(gatewayEndpoint + "/api/notify-group"))
                    .header("Content-Type", "application/json")
                    .timeout(Duration.ofSeconds(3))
                    .POST(HttpRequest.BodyPublishers.ofString(jsonPayload))
                    .build();

            httpClient.sendAsync(req, HttpResponse.BodyHandlers.discarding());
        } catch (Exception e) {
            System.err.println("[WhatsAppBridge Error] " + e.getMessage());
        }
    }
}
