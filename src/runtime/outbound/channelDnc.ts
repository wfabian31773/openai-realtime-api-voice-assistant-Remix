/**
 * SMS and voice opt-outs share `do_not_contact` but not a row.
 * One row per (phone_key, source). START deletes only `sms_stop`.
 * A later voice "don't call me" is its own row; START cannot erase it.
 *
 * READS ARE STRICT: any row for the phone, whatever its source, blocks both
 * calls and texts. A STOP blocks calls; a voice opt-out blocks texts.
 */
export const SMS_DNC_SOURCE = "sms_stop";

export class ChannelDoNotContact {
  /** Voice / call opt-outs. Keyed on last-10. */
  readonly voice = new Map<string, string>();
  /** SMS STOP numbers. Keyed on last-10. */
  readonly sms = new Set<string>();

  private anyRow(phoneKey: string): boolean {
    return this.voice.has(phoneKey) || this.sms.has(phoneKey);
  }

  isVoiceBlocked(phoneKey: string | null): boolean {
    if (!phoneKey) return true;
    return this.anyRow(phoneKey);
  }

  isSmsBlocked(phoneKey: string): boolean {
    return this.anyRow(phoneKey);
  }

  stamp(phoneKey: string | null, source: string): void {
    if (!phoneKey) return;
    if (source === SMS_DNC_SOURCE) {
      this.sms.add(phoneKey);
      return;
    }
    if (!this.voice.has(phoneKey)) this.voice.set(phoneKey, source);
  }

  setSms(phoneKey: string, optedOut: boolean): void {
    if (optedOut) this.sms.add(phoneKey);
    else this.sms.delete(phoneKey);
  }
}
