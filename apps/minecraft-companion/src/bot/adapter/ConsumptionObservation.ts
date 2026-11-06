/** A passive fixed-device evidence capture, with no item-use capability. */
export interface ConsumptionObservation {
  /** Arm only after the bound device confirms the selected item in hand. */
  arm(): boolean;
  read(): Readonly<{
    status: 'observed' | 'unknown'; actor: string; dimension: string; item: string;
    beforeCount: number | null; afterCount: number | null;
    consumptionEvents: number; inventoryEvents: number;
  }>;
  close(): void;
}
/** Separate interface: GameView implementations need not support native event proof. */
export interface ConsumptionObservationSource {
  captureConsumption(item: string, signal: AbortSignal): ConsumptionObservation | null;
}
