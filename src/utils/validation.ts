/**
 * Validates if a string is a valid URL with http or https protocol
 */
export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Sanitizes a filename to prevent path traversal and remove unsafe characters
 */
export function sanitizeFilename(filename: string): string {
  // Remove path separators and parent directory references
  let sanitized = filename.replace(/[\/\\]/g, '_').replace(/\.\./g, '_');

  // Remove other potentially dangerous characters
  sanitized = sanitized.replace(/[<>:"|?*\x00-\x1F]/g, '_');

  // Trim whitespace and dots from start/end
  sanitized = sanitized.trim().replace(/^\.+|\.+$/g, '');

  // If filename becomes empty after sanitization, use a default
  if (!sanitized) {
    sanitized = 'file';
  }

  return sanitized;
}
