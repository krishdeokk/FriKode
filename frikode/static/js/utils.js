/**
 * FriKode UI Utilities
 * Toast notifications, clipboard helpers, time formatting, and color palettes.
 */

export const ACCENT_COLORS = [
  "#22d3ee", // electric cyan
  "#a855f7", // vivid violet
  "#38bdf8", // sky blue
  "#ec4899", // pink
  "#10b981", // emerald
  "#f59e0b", // amber
  "#6366f1", // indigo
  "#14b8a6"  // teal
];

export function getRandomColor() {
  return ACCENT_COLORS[Math.floor(Math.random() * ACCENT_COLORS.length)];
}

export function copyToClipboard(text, successMsg = "Copied to clipboard") {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(successMsg, "success");
    }).catch(() => {
      _fallbackCopy(text, successMsg);
    });
  } else {
    _fallbackCopy(text, successMsg);
  }
}

function _fallbackCopy(text, successMsg) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand("copy");
    showToast(successMsg, "success");
  } catch (err) {
    showToast("Failed to copy", "error");
  }
  document.body.removeChild(textArea);
}

export function showToast(message, type = "info", duration = 3000) {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  
  let iconHtml = "";
  if (type === "success") {
    iconHtml = `<span style="color: #10b981;">✓</span>`;
  } else if (type === "error") {
    iconHtml = `<span style="color: #f43f5e;">✕</span>`;
  }

  toast.innerHTML = `${iconHtml}<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
    toast.style.transition = "all 0.2s ease";
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 200);
  }, duration);
}

export function formatTime(timestamp) {
  const date = new Date(timestamp * 1000);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function safeGetStorage(key, fallback = null) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (_) {
    return fallback;
  }
}

export function safeSetStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {}
}

