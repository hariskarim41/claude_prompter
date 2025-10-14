/**
 * Temporary Gate Registry
 *
 * Manages in-memory storage and lifecycle for execution-scoped gates that don't persist to filesystem.
 * Provides automatic cleanup, scope management, and integration with existing gate systems.
 */

import { Logger } from '../../logging/index.js';
import type { GateDefinition } from '../types.js';

/**
 * Temporary gate definition with lifecycle management
 */
export interface TemporaryGateDefinition {
  /** Unique identifier (UUID-based to prevent conflicts) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Gate type */
  type: 'validation' | 'approval' | 'condition' | 'quality' | 'guidance';
  /** Scope of the temporary gate */
  scope: 'execution' | 'session' | 'chain' | 'step';
  /** Description of what this gate checks/guides */
  description: string;
  /** Guidance text injected into prompts */
  guidance: string;
  /** Pass/fail criteria for validation gates */
  pass_criteria?: any[];
  /** Creation timestamp */
  created_at: number;
  /** Expiration timestamp (optional) */
  expires_at?: number;
  /** Source of gate creation */
  source: 'manual' | 'automatic' | 'analysis';
  /** Additional context for gate creation */
  context?: Record<string, any>;
  /** Associated execution/session/chain ID */
  scope_id?: string;
}

/**
 * Scope management information
 */
interface ScopeInfo {
  scope_type: 'execution' | 'session' | 'chain' | 'step';
  scope_id: string;
  gates: Set<string>;
  created_at: number;
  expires_at?: number;
}

/**
 * Registry for managing temporary gates
 */
export class TemporaryGateRegistry {
  private logger: Logger;
  private temporaryGates: Map<string, TemporaryGateDefinition>;
  private scopeManagement: Map<string, ScopeInfo>;
  private cleanupTimers: Map<string, NodeJS.Timeout>;
  private maxMemoryGates: number;
  private defaultExpirationMs: number;

  constructor(
    logger: Logger,
    options: {
      maxMemoryGates?: number;
      defaultExpirationMs?: number;
    } = {}
  ) {
    this.logger = logger;
    this.temporaryGates = new Map();
    this.scopeManagement = new Map();
    this.cleanupTimers = new Map();
    this.maxMemoryGates = options.maxMemoryGates || 1000;
    this.defaultExpirationMs = options.defaultExpirationMs || 3600000; // 1 hour

    this.logger.debug('[TEMP GATE REGISTRY] Initialized with max gates:', this.maxMemoryGates);
  }

  /**
   * Create a new temporary gate
   */
  createTemporaryGate(
    definition: Omit<TemporaryGateDefinition, 'id' | 'created_at'>,
    scopeId?: string
  ): string {
    // Generate unique ID
    const gateId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Check memory limits
    if (this.temporaryGates.size >= this.maxMemoryGates) {
      this.performCleanup();
      if (this.temporaryGates.size >= this.maxMemoryGates) {
        throw new Error(`Temporary gate registry at capacity (${this.maxMemoryGates})`);
      }
    }

    const now = Date.now();
    const tempGate: TemporaryGateDefinition = {
      id: gateId,
      created_at: now,
      expires_at: definition.expires_at || (now + this.defaultExpirationMs),
      scope_id: scopeId,
      ...definition
    };

    // Store the gate
    this.temporaryGates.set(gateId, tempGate);

    // Manage scope association
    if (scopeId) {
      this.associateWithScope(gateId, definition.scope, scopeId);
    }

    // Set up automatic cleanup
    if (tempGate.expires_at) {
      const cleanupTimeout = setTimeout(() => {
        this.removeTemporaryGate(gateId);
      }, tempGate.expires_at - now);

      this.cleanupTimers.set(gateId, cleanupTimeout);
    }

    this.logger.debug(`[TEMP GATE REGISTRY] Created temporary gate:`, {
      id: gateId,
      name: tempGate.name,
      scope: tempGate.scope,
      scopeId,
      expiresAt: tempGate.expires_at
    });

    return gateId;
  }

  /**
   * Get a temporary gate by ID
   */
  getTemporaryGate(gateId: string): TemporaryGateDefinition | undefined {
    return this.temporaryGates.get(gateId);
  }

  /**
   * Get all temporary gates for a specific scope
   */
  getTemporaryGatesForScope(scope: string, scopeId: string): TemporaryGateDefinition[] {
    const scopeKey = `${scope}:${scopeId}`;
    const scopeInfo = this.scopeManagement.get(scopeKey);

    if (!scopeInfo) {
      return [];
    }

    const gates: TemporaryGateDefinition[] = [];
    for (const gateId of scopeInfo.gates) {
      const gate = this.temporaryGates.get(gateId);
      if (gate) {
        gates.push(gate);
      }
    }

    return gates;
  }

  /**
   * Get all active temporary gates
   */
  getAllTemporaryGates(): TemporaryGateDefinition[] {
    return Array.from(this.temporaryGates.values());
  }

  /**
   * Convert temporary gate to standard gate definition
   */
  convertToStandardGate(tempGate: TemporaryGateDefinition): GateDefinition {
    return {
      id: tempGate.id,
      name: tempGate.name,
      type: tempGate.type,
      description: tempGate.description,
      requirements: [], // Temporary gates use simplified criteria
      failureAction: 'retry',
      guidance: tempGate.guidance,
      pass_criteria: tempGate.pass_criteria,
      retry_config: {
        max_attempts: 3,
        improvement_hints: true,
        preserve_context: true
      },
      activation: {
        explicit_request: true
      }
    };
  }

  /**
   * Remove a temporary gate
   */
  removeTemporaryGate(gateId: string): boolean {
    const gate = this.temporaryGates.get(gateId);
    if (!gate) {
      return false;
    }

    // Remove from registry
    this.temporaryGates.delete(gateId);

    // Clean up scope associations
    if (gate.scope_id) {
      this.removeFromScope(gateId, gate.scope, gate.scope_id);
    }

    // Cancel cleanup timer
    const timer = this.cleanupTimers.get(gateId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(gateId);
    }

    this.logger.debug(`[TEMP GATE REGISTRY] Removed temporary gate: ${gateId}`);
    return true;
  }

  /**
   * Clean up expired gates and scopes
   */
  cleanupExpiredGates(): number {
    const now = Date.now();
    let cleanedCount = 0;

    // Clean up expired gates
    for (const [gateId, gate] of this.temporaryGates.entries()) {
      if (gate.expires_at && gate.expires_at <= now) {
        this.removeTemporaryGate(gateId);
        cleanedCount++;
      }
    }

    // Clean up expired scopes
    for (const [scopeKey, scopeInfo] of this.scopeManagement.entries()) {
      if (scopeInfo.expires_at && scopeInfo.expires_at <= now) {
        this.cleanupScopeByKey(scopeKey);
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`[TEMP GATE REGISTRY] Cleaned up ${cleanedCount} expired gates`);
    }

    return cleanedCount;
  }

  /**
   * Clean up all gates for a specific scope
   */
  cleanupScope(scope: string, scopeId?: string): number {
    const scopeKey = scopeId ? `${scope}:${scopeId}` : scope;
    const scopeInfo = this.scopeManagement.get(scopeKey);

    if (!scopeInfo) {
      return 0;
    }

    let cleanedCount = 0;
    for (const gateId of scopeInfo.gates) {
      if (this.removeTemporaryGate(gateId)) {
        cleanedCount++;
      }
    }

    this.scopeManagement.delete(scopeKey);

    this.logger.debug(`[TEMP GATE REGISTRY] Cleaned up scope ${scopeKey}: ${cleanedCount} gates`);
    return cleanedCount;
  }

  /**
   * Clean up all gates for a chain execution
   * Removes all chain-scoped gates and associated step-scoped gates
   */
  cleanupChainExecution(chainExecutionId: string): number {
    this.logger.debug(`[TEMP GATE REGISTRY] Cleaning up chain execution: ${chainExecutionId}`);

    let totalCleaned = 0;

    // Clean up chain-scoped gates
    totalCleaned += this.cleanupScope('chain', chainExecutionId);

    // Clean up any step-scoped gates associated with this chain
    const stepScopesToClean: string[] = [];
    for (const [scopeKey, scopeInfo] of this.scopeManagement.entries()) {
      if (scopeInfo.scope_type === 'step' && scopeKey.includes(chainExecutionId)) {
        stepScopesToClean.push(scopeKey);
      }
    }

    for (const scopeKey of stepScopesToClean) {
      this.cleanupScopeByKey(scopeKey);
      totalCleaned++;
    }

    this.logger.info(`[TEMP GATE REGISTRY] Chain ${chainExecutionId} cleanup: ${totalCleaned} gates removed`);
    return totalCleaned;
  }

  /**
   * Clean up all gates for an execution scope
   * Convenience method for execution-scoped cleanups
   */
  cleanupExecutionScope(executionId: string): number {
    return this.cleanupScope('execution', executionId);
  }

  /**
   * Get registry statistics
   */
  getStatistics() {
    const now = Date.now();
    const gates = Array.from(this.temporaryGates.values());

    const expiredCount = gates.filter(g => g.expires_at && g.expires_at <= now).length;
    const byScope = gates.reduce((acc, gate) => {
      acc[gate.scope] = (acc[gate.scope] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const bySource = gates.reduce((acc, gate) => {
      acc[gate.source] = (acc[gate.source] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      totalGates: this.temporaryGates.size,
      maxCapacity: this.maxMemoryGates,
      utilizationPercent: Math.round((this.temporaryGates.size / this.maxMemoryGates) * 100),
      expiredGates: expiredCount,
      activeScopes: this.scopeManagement.size,
      activeCleanupTimers: this.cleanupTimers.size,
      gatesByScope: byScope,
      gatesBySource: bySource,
      memoryUsageEstimate: this.estimateMemoryUsage()
    };
  }

  /**
   * Force cleanup to free memory
   */
  private performCleanup(): void {
    this.logger.debug('[TEMP GATE REGISTRY] Performing forced cleanup');

    // First try cleaning expired gates
    const expiredCleaned = this.cleanupExpiredGates();

    // If still at capacity, remove oldest gates
    if (this.temporaryGates.size >= this.maxMemoryGates) {
      const gates = Array.from(this.temporaryGates.values())
        .sort((a, b) => a.created_at - b.created_at);

      const toRemove = Math.min(100, gates.length - Math.floor(this.maxMemoryGates * 0.8));
      for (let i = 0; i < toRemove; i++) {
        this.removeTemporaryGate(gates[i].id);
      }

      this.logger.warn(`[TEMP GATE REGISTRY] Force removed ${toRemove} oldest gates`);
    }
  }

  /**
   * Associate gate with scope
   */
  private associateWithScope(gateId: string, scope: string, scopeId: string): void {
    const scopeKey = `${scope}:${scopeId}`;

    if (!this.scopeManagement.has(scopeKey)) {
      this.scopeManagement.set(scopeKey, {
        scope_type: scope as any,
        scope_id: scopeId,
        gates: new Set(),
        created_at: Date.now()
      });
    }

    this.scopeManagement.get(scopeKey)!.gates.add(gateId);
  }

  /**
   * Remove gate from scope
   */
  private removeFromScope(gateId: string, scope: string, scopeId: string): void {
    const scopeKey = `${scope}:${scopeId}`;
    const scopeInfo = this.scopeManagement.get(scopeKey);

    if (scopeInfo) {
      scopeInfo.gates.delete(gateId);

      // Remove scope if empty
      if (scopeInfo.gates.size === 0) {
        this.scopeManagement.delete(scopeKey);
      }
    }
  }

  /**
   * Cleanup scope by key
   */
  private cleanupScopeByKey(scopeKey: string): void {
    const scopeInfo = this.scopeManagement.get(scopeKey);
    if (scopeInfo) {
      for (const gateId of scopeInfo.gates) {
        this.removeTemporaryGate(gateId);
      }
      this.scopeManagement.delete(scopeKey);
    }
  }

  /**
   * Estimate memory usage
   */
  private estimateMemoryUsage(): number {
    // Rough estimation: 1KB per gate + scope overhead
    const gateSize = this.temporaryGates.size * 1024;
    const scopeSize = this.scopeManagement.size * 256;
    const timerSize = this.cleanupTimers.size * 64;

    return gateSize + scopeSize + timerSize;
  }

  /**
   * Cleanup all resources
   */
  destroy(): void {
    this.logger.debug('[TEMP GATE REGISTRY] Destroying registry');

    // Clear all timers
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }

    // Clear all data
    this.temporaryGates.clear();
    this.scopeManagement.clear();
    this.cleanupTimers.clear();
  }
}

/**
 * Factory function for creating temporary gate registry
 */
export function createTemporaryGateRegistry(
  logger: Logger,
  options?: {
    maxMemoryGates?: number;
    defaultExpirationMs?: number;
  }
): TemporaryGateRegistry {
  return new TemporaryGateRegistry(logger, options);
}