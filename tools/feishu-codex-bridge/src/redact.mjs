export function redactSecrets(value) {
  return String(value ?? '')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"'}]+/giu, '<redacted authorization>')
    .replace(/(app_secret|authorization|access_token|refresh_token|secret|token)["'=:\s]+[^\s,"'}]+/giu, '$1=<redacted>');
}
