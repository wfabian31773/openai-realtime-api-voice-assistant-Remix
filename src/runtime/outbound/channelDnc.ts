/**
 * SMS and voice opt-outs share `do_not_contact`, one row per phone (the
 * primary key the Hub has carried since v105). STOP writes `sms_stop` when
 * the phone has no row; a voice "don't call me" takes an `sms_stop` row over.
 * START deletes only `sms_stop`, so it cannot erase a voice opt-out.
 *
 * This in-memory model keeps the two channels in two sets. That is the same
 * behaviour as the one-row table: a phone with a voice entry stays blocked
 * after START either way.
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
