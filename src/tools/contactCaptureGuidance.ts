/**
 * Shared wording for identity fields captured by voice tools. A validated
 * joined record supplies fields it already holds; these instructions apply
 * when the caller needs to provide or correct a value.
 */
export const LAST_NAME_FIELD_DESCRIPTION =
  "Patient's surname. If the transcription sounds like a place name or is uncertain, ask the caller to spell it letter by letter, then repeat the spelling back for confirmation. Do not ask again when the verified joined record already has the surname.";

export const LAST_NAME_ASK =
  'May I please have your last name? Please spell it letter by letter.';

export const EMAIL_CONFIRMATION_DESCRIPTION =
  'If the caller provides or changes an email address, ask them to spell it, read the complete address back, and ask them to confirm it before filing. Pass the complete address unchanged; never shorten or clip it.';

export const EMAIL_FIELD_DESCRIPTION =
  `${EMAIL_CONFIRMATION_DESCRIPTION} Do not ask again for an address already held on the verified joined record.`;

export const EMAIL_ASK =
  "What's the email address? Please spell it out for me, letter by letter.";
