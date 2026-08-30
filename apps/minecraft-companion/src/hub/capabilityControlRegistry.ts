export type CapabilityControlKind = 'base' | 'proactive_goal' | 'internal_service';

export interface CapabilityControlDescriptor {
  readonly method: 'PATCH';
  readonly href: string;
}

export interface CapabilityControlView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon: string;
  readonly kind: CapabilityControlKind;
  readonly enabled: boolean;
  readonly defaultEnabled: boolean;
  readonly statusLabel: string;
  readonly control?: CapabilityControlDescriptor;
}

export interface CapabilityControlSnapshot {
  readonly capabilities: readonly CapabilityControlView[];
}

export interface CapabilityControlRegistration extends Omit<CapabilityControlView, 'control'> {
  readonly setEnabled?: (enabled: boolean) => void | Promise<void>;
}

export class CapabilityControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CapabilityControlError';
  }
}

/**
 * Hub 组合根的通用能力控制目录。页面只消费 control 描述；具体执行通道由注册器闭包决定。
 */
export class CapabilityControlRegistry {
  private readonly registrations = new Map<string, CapabilityControlRegistration>();

  constructor(private readonly basePath: string) {}

  register(registration: CapabilityControlRegistration): void {
    if (!registration.id.trim()) throw new Error('capability id is required');
    if (this.registrations.has(registration.id)) {
      throw new Error(`duplicate capability control: ${registration.id}`);
    }
    this.registrations.set(registration.id, registration);
  }

  snapshot(): CapabilityControlSnapshot {
    return Object.freeze({
      capabilities: Object.freeze(Array.from(this.registrations.values(), registration => Object.freeze({
        id: registration.id,
        label: registration.label,
        description: registration.description,
        icon: registration.icon,
        kind: registration.kind,
        enabled: registration.enabled,
        defaultEnabled: registration.defaultEnabled,
        statusLabel: registration.statusLabel,
        ...(registration.setEnabled ? {
          control: Object.freeze({
            method: 'PATCH' as const,
            href: `${this.basePath}/${encodeURIComponent(registration.id)}`,
          }),
        } : {}),
      }))),
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const registration = this.registrations.get(id);
    if (!registration) throw new CapabilityControlError('capability not found', 404);
    if (!registration.setEnabled) throw new CapabilityControlError('capability is read only', 409);
    await registration.setEnabled(enabled);
  }
}
