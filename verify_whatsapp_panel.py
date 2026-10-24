import urllib.request
import json

def verify():
    # 1. Verify /room template
    html = urllib.request.urlopen('http://localhost:5050/room').read().decode('utf-8')
    assert 'WhatsApp Community Bridge & IT Desk' in html, "Missing WhatsApp panel"
    assert 'perpetua' in html, "Missing perpetua group"
    assert 'Perpetua - IT Helpdesk' in html, "Missing IT Helpdesk group"
    assert 'Perpetua - Admin Oversight' in html, "Missing Admin Oversight group"
    assert 'tickets-container' in html, "Missing tickets container"
    assert 'create-ticket-modal' in html, "Missing create ticket modal"
    print("[OK] HTML template verification passed: All WhatsApp Community Bridge & IT Desk components present.")

    # 2. Verify static assets
    css = urllib.request.urlopen('http://localhost:5050/static/css/room.css').read().decode('utf-8')
    assert 'whatsapp-groups-strip' in css, "Missing CSS for whatsapp-groups-strip"
    assert 'ticket-card' in css, "Missing CSS for ticket-card"
    assert 'body.theme-droplet .ticket-card' in css, "Missing Droplet Glass CSS for ticket-card"
    print("[OK] CSS verification passed: Both Studio Dark and Droplet Glass styles present.")

    js = urllib.request.urlopen('http://localhost:5050/static/js/room.js').read().decode('utf-8')
    assert 'renderTickets' in js, "Missing renderTickets in JS"
    assert 'resolveTicket' in js, "Missing resolveTicket in JS"
    assert 'openCreateTicketModal' in js, "Missing openCreateTicketModal in JS"
    print("[OK] JS verification passed: Live polling and ticket interaction handlers present.")

    # 3. Verify /room/state API
    state_res = urllib.request.urlopen('http://localhost:5050/room/state').read().decode('utf-8')
    state = json.loads(state_res)
    assert 'tickets' in state, "Missing tickets in state"
    assert 'tickets_open' in state, "Missing tickets_open in state"
    print(f"[OK] State API verified: Found {len(state['tickets'])} tickets ({state['tickets_open']} open).")

    # 4. Test creating a sample WhatsApp ticket via API
    post_data = json.dumps({
        "title": "Camera optical sync verification in Alcove Studio",
        "description": "Verifying deterministic matrix pin for sconce during live render",
        "reported_by": "Worker_Camera1",
        "severity": "MEDIUM",
        "associated_task_id": "task_9bd03388"
    }).encode('utf-8')
    req = urllib.request.Request('http://localhost:5050/api/tickets', data=post_data, headers={'Content-Type': 'application/json'})
    res = urllib.request.urlopen(req)
    created = json.loads(res.read().decode('utf-8'))
    assert created['status'] == 'success'
    ticket_id = created['ticket']['ticket_id']
    print(f"[OK] Successfully created ticket {ticket_id}")

    # 5. Test resolving the ticket
    resolve_data = json.dumps({
        "resolved_by": "LeadEngineer",
        "notes": "Verified sconce pinning at (0.22, 0.18, 0.0) with zero drift."
    }).encode('utf-8')
    req_res = urllib.request.Request(f'http://localhost:5050/api/tickets/{ticket_id}/resolve', data=resolve_data, headers={'Content-Type': 'application/json'})
    res_res = urllib.request.urlopen(req_res)
    resolved = json.loads(res_res.read().decode('utf-8'))
    assert resolved['status'] == 'success'
    assert resolved['ticket']['status'] == 'RESOLVED'
    print(f"[OK] Successfully resolved ticket {ticket_id}")

    print("\n>>> ALL VERIFICATION CHECKS PASSED SUCCESSFULLY! <<<")

if __name__ == '__main__':
    verify()
