/**
 * ==============================================================================
 * TMS LEASED FEATURE - BROADCAST & REPORTER INTERFACE CONTRACTS
 * ==============================================================================
 * Formal architectural contracts governing the Leased Feature Messaging Bridge,
 * Reporter dispatchers, Tabulated Receivers, and Grammar Compositions.
 * ==============================================================================
 */

/**
 * Standard status states for a leased feature
 */
export type LeaseStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'PENDING';

/**
 * Core action types emitted across the broadcast channel
 */
export type LeaseActionType =
  | 'BROADCASTER_READY'
  | 'LEASE_PLUGGED'
  | 'LEASE_DROPPED'
  | 'CHUNK_SELECTED'
  | 'TENANT_SWITCHED'
  | 'PILOT_MODE_TOGGLED'
  | 'MIDNIGHT_SWEEP_SIMULATION'
  | 'MIDNIGHT_SWEEP_REVOCATION'
  | 'WORKER_AUDIT_VERIFIED'
  | 'EMERGENCY_UNPLUG'
  | 'CONTRACT_RENEWED'
  | 'TECHNICAL_CHRONICLE_PUBLISHED'
  | 'DOCUMENTATION_AUDIT_LOGGED'
  | 'TIME_CARD_TICK'
  | 'PACKET_REASSEMBLY_CHECK'
  | 'WORKER_HEALTHY_EXECUTABLE'
  | 'TOOLS_UNPACKED'
  | 'GOOGLE_DRIVE_ROOM_MOUNTED'
  | 'HANDSHAKE_INITIATED'
  | 'HANDSHAKE_ACKNOWLEDGED'
  | 'HANDSHAKE_TIMEOUT_REPORTED';

/**
 * Metadata defining an entity capable of reporting lease events
 */
export interface ILeaseReporter {
  id: string;
  name: string;
  role: 'WORKER_DAEMON' | 'CANVAS_OPERATOR' | 'SYSTEM_CRON' | 'HEALTH_AUDITOR' | 'TECHNICAL_WRITER' | 'TIME_INSPECTOR_DAEMON';
  description: string;
  defaultChannel: string;
}

/**
 * The unified payload envelope broadcast across BroadcastChannel and CustomEvents
 */
export interface ILeaseMessage {
  id: string;
  reporter: string;
  type: LeaseActionType;
  tenantId: string;
  tenantName?: string;
  chunkId?: string;
  chunkName?: string;
  status: LeaseStatus;
  pilotMode?: boolean;
  timestamp: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

/**
 * Receiver callback and lifecycle subscriber interface
 */
export interface ILeaseReceiver {
  channelName: string;
  subscribe: (callback: (message: ILeaseMessage) => void) => () => void;
  broadcast: (message: Partial<ILeaseMessage>) => ILeaseMessage;
}

/**
 * Standard tabulated format row for logging and UI displays
 */
export interface ITabulatedReportRow {
  'Message ID': string;
  'Reporter / Sender': string;
  'Action / Type': string;
  'Tenant (Noun)': string;
  'Target Chunk (Object)': string;
  'Lease Status': string;
  'Channel': string;
  'Timestamp': string;
  'Summary / Details': string;
}

/**
 * Result returned by the Midnight Reconciler daemon sweep
 */
export interface ILeaseReconciliationResult {
  evaluatedShops: number;
  expiredLeasesFound: number;
  leasesRevoked: Array<{
    shop: string;
    feature: string;
    source: string;
  }>;
  errors: Array<{
    shop?: string;
    error: string;
  }>;
}

/**
 * Functional grammar representation: [Tenant Noun] + [Lease Verb] + [Chunk Object]
 */
export interface ILeaseGrammarSentence {
  subject: {
    id: string;
    name: string;
    subdomain: string;
  };
  verb: {
    status: LeaseStatus;
    action: string;
    reconciliationSchedule: string;
  };
  object: {
    id: string;
    name: string;
    componentName: string;
    status: 'PLUGGED' | 'DROPPED';
  };
}

/**
 * Time Card presented to the worker during the 1-second cadence inspection
 */
export interface ITimeCard {
  tag: string;
  greeting: string;
  rawText: string;
  formattedTime: string; // "hh.mm.ss dd.mm.year"
  timestamp: string;
}

/**
 * Packet integrity inspection results
 */
export interface IPacketIntegrityResult {
  totalExpected: number;
  receivedPackets: number;
  inFlightPackets: number;
  movingPackets: number;
  droppedPackets: number;
  packetsArrivedInFull: boolean;
  noPacketsMoving: boolean;
  packetsCameAllOfThem: boolean;
  integrityRatio: string;
  checksum: string;
}

/**
 * Worker status following self-reassembly
 */
export interface IWorkerReassemblyStatus {
  state: 'HEALTHY_AND_EXECUTABLE' | 'REASSEMBLING' | 'CORRUPTED';
  goAhead: boolean;
  verdict: string;
  toolsUnpacked: boolean;
  toolsCount: number;
}

/**
 * Google Drive Live Files Room specification (5-minute live lease window)
 */
export interface IGoogleDriveLiveRoom {
  roomName: string;
  driveUri: string;
  leaseDurationSeconds: number; // 300 seconds (5 min)
  expiryTime: string;
  liveFiles: Array<{
    name: string;
    type: string;
    size: string;
    status: 'LIVE_SYNC' | 'STREAMING' | 'MOUNTED' | 'LIVE_BUFFER' | 'REALTIME';
  }>;
  status: 'LIVE_ROOM_MOUNTED_5_MINUTES' | 'EXPIRED';
}

/**
 * Handshake liveness and timeout audit report
 * Implements the invariant: "Wait for the handshake. If no response you report. But not always. When you've been waiting for too long."
 */
export interface IHandshakeReport {
  handshakeId: string;
  peerId: string;
  status: 'SYN_SENT' | 'ACKNOWLEDGED' | 'WAITING_WITHIN_GRACE' | 'TIMEOUT_EXCEEDED';
  waitedMs: number;
  gracePeriodMs: number;
  timeoutThresholdMs: number;
  shouldReportTimeout: boolean;
  verdict: string;
  incidentDetails?: {
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    reason: string;
    actionRequired: string;
  };
}
