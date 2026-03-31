const API_URL = "http://127.0.0.1:8000/api";
const SERVER_OFFLINE_MESSAGE =
  "Backend server is not running on http://127.0.0.1:8000. Start the Django server and try again.";
const KNOWN_CONVERSATIONS_STORAGE_KEY_PREFIX = "vloop_known_conversations";
const CHAT_UI_STATE_STORAGE_KEY_PREFIX = "vloop_chat_ui_state";

function getHeaders(includeJson = true) {
  const token = localStorage.getItem("access_token");
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (includeJson) headers["Content-Type"] = "application/json";
  return headers;
}

function hasActiveSession() {
  return Boolean(localStorage.getItem("access_token"));
}

function requireAuth(message = "Please login to continue.") {
  if (hasActiveSession()) return true;
  alert(message);
  location.href = "login.html";
  return false;
}

let allItems = [];
let allMessages = [];
let conversationSummaries = [];
let currentFilter = "all";
let currentSearchQuery = "";
let chatSocket = null;
let currentChatUserId = null;
let currentChatUserEmail = null;
let typingTimeout = null;
let activeTypingUserId = null;
let toastTimeout = null;
let hasLoadedMessagesOnce = false;
let messagePollingHandle = null;
let currentProfile = null;
let chatSocketReceiverId = null;
let currentChatUserName = null;
let currentChatUserAvatar = "";
let currentChatUserStatus = "";
let knownConversations = new Map();
let isChatOpenExplicitly = false; // only true when user explicitly opens chat panel
let pendingSecurityChallengeToken = "";
let pendingSecurityQuestion = "";
let pendingProfilePictureRemoval = false;
let loginRequestInFlight = false;
let securityQuestionRequestInFlight = false;
let conversationSearchQuery = "";
let messageSearchQuery = "";
let forwardSearchQuery = "";
let replyingToMessage = null;
let forwardingMessage = null;
let pendingChatAttachment = null;
let chatTheme = localStorage.getItem("chat_theme") || "light";
let openMessageMenuId = null;
let pendingChatUiRestore = null;
let lastConversationListRenderSignature = "";
let lastConversationThreadRenderSignature = "";
let notifiedMessageIds = [];

document.addEventListener("DOMContentLoaded", () => {
  loadKnownConversationsCache();
  const chatInput = document.getElementById("chat-input");
  if (chatInput) {
    chatInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        sendMessage(event);
        return;
      }
      sendTypingState(true);
      window.clearTimeout(typingTimeout);
      typingTimeout = window.setTimeout(() => sendTypingState(false), 900);
    });
    chatInput.addEventListener("input", () => autoResizeChatInput());
    autoResizeChatInput();
  }

  bindAuthShortcuts();
  bindMarketplaceForms();
  bindChatExperience();
  bindNotificationPermissionPrompt();
  applyChatTheme();
});

function bindAuthShortcuts() {
  const loginForm = document.getElementById("login-form-element");
  const signupForm = document.getElementById("signup-form-element");
  const securityForm = document.getElementById(
    "security-question-form-element",
  );

  if (loginForm) {
    loginForm.addEventListener("submit", (event) => login(event));
    loginForm.addEventListener("keydown", (event) =>
      handleExplicitSubmitOnlyKeydown(event),
    );
  }

  if (signupForm) {
    signupForm.addEventListener("submit", (event) => signup(event));
    signupForm.addEventListener("keydown", (event) =>
      handleExplicitSubmitOnlyKeydown(event),
    );
  }

  if (securityForm) {
    securityForm.addEventListener("submit", (event) =>
      verifySecurityQuestion(event),
    );
    securityForm.addEventListener("keydown", (event) =>
      handleExplicitSubmitOnlyKeydown(event),
    );
  }
}

function bindMarketplaceForms() {
  document
    .getElementById("profile-form")
    ?.addEventListener("submit", (event) => saveProfile(event));
  document
    .getElementById("profile-password-form")
    ?.addEventListener("submit", (event) => updateProfilePassword(event));
  document
    .getElementById("two-step-form")
    ?.addEventListener("submit", (event) => saveTwoStepPreference(event));
  document
    .getElementById("delete-account-form")
    ?.addEventListener("submit", (event) => deleteAccount(event));
  document
    .getElementById("post-item-form")
    ?.addEventListener("submit", (event) => handlePostItemSubmit(event));
  document
    .getElementById("post-item-form")
    ?.addEventListener("keydown", (event) => handlePostItemFormKeydown(event));
  document
    .getElementById("profile-picture-input")
    ?.addEventListener("change", previewProfilePicture);
  document
    .getElementById("security-question-select")
    ?.addEventListener("change", () => syncSecurityQuestionInputs());
  document
    .getElementById("two-step-enabled")
    ?.addEventListener("change", () => updateTwoStepDisablePrompt());
  document
    .getElementById("image")
    ?.addEventListener("change", updateListingImageLabel);
}

function bindChatExperience() {
  document
    .getElementById("conversation-search")
    ?.addEventListener("input", (event) => {
      conversationSearchQuery = normalizeSearchText(event.target.value);
      renderConversationList();
    });
  document
    .getElementById("message-search")
    ?.addEventListener("input", (event) => {
      messageSearchQuery = normalizeSearchText(event.target.value);
      renderCurrentConversation();
    });
  document
    .getElementById("chat-attachment-input")
    ?.addEventListener("change", handleChatAttachmentChange);
  document
    .getElementById("chat-composer-form")
    ?.addEventListener("submit", sendMessage);
  document
    .getElementById("chat-input")
    ?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
  document
    .getElementById("forward-search")
    ?.addEventListener("input", (event) => {
      forwardSearchQuery = normalizeSearchText(event.target.value);
      renderForwardRecipientList();
    });
  document.addEventListener("click", (event) => {
    const picker = document.getElementById("emoji-picker");
    if (!picker || picker.classList.contains("hidden")) return;
    if (
      event.target.closest("#emoji-picker") ||
      event.target.closest("#chat-emoji-toggle")
    )
      return;
    picker.classList.add("hidden");
  });
  document.addEventListener("click", (event) => {
    if (
      event.target.closest("[data-menu-button]") ||
      event.target.closest("[data-message-menu]")
    )
      return;
    if (openMessageMenuId !== null) {
      openMessageMenuId = null;
      renderCurrentConversation();
    }
  });
}

function normalizeEmailValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeSearchText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeSecurityText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function handleExplicitSubmitOnlyKeydown(event) {
  if (event.key !== "Enter") return;

  const target = event.target;
  const tagName = target?.tagName?.toLowerCase();
  const inputType = String(target?.type || "").toLowerCase();
  const shouldAllowEnter =
    tagName === "textarea" || inputType === "submit" || inputType === "button";

  if (!shouldAllowEnter) {
    event.preventDefault();
  }
}

function updateMarketplaceAccessState() {
  const isAuthenticated = hasActiveSession();
  document
    .getElementById("marketplace-login-button")
    ?.classList.toggle("hidden", isAuthenticated);
  document
    .getElementById("profile-nav-button")
    ?.classList.toggle("hidden", !isAuthenticated);
  document
    .getElementById("chat-nav-button")
    ?.classList.toggle("hidden", !isAuthenticated);
  document
    .getElementById("post-item-button")
    ?.classList.toggle("hidden", !isAuthenticated);
  document
    .getElementById("marketplace-guest-banner")
    ?.classList.toggle("hidden", isAuthenticated);
}

function getSelectedSecurityQuestion() {
  const select = document.getElementById("security-question-select");
  const custom = document.getElementById("security-question-custom");
  const selected = select?.value || "";
  if (selected === "__custom__") {
    return normalizeSecurityText(custom?.value);
  }
  return normalizeSecurityText(selected);
}

function syncSecurityQuestionInputs(forceQuestion = "") {
  const select = document.getElementById("security-question-select");
  const customWrap = document.getElementById("security-question-custom-wrap");
  const customInput = document.getElementById("security-question-custom");
  if (!select || !customWrap || !customInput) return;

  const question = normalizeSecurityText(forceQuestion);
  const options = Array.from(select.options).map((option) => option.value);
  if (question && options.includes(question)) {
    select.value = question;
    customInput.value = "";
    customWrap.classList.add("hidden");
    return;
  }

  if (question) {
    select.value = "__custom__";
    customInput.value = question;
    customWrap.classList.remove("hidden");
    return;
  }

  customWrap.classList.toggle("hidden", select.value !== "__custom__");
  if (select.value !== "__custom__") {
    customInput.value = "";
  }
}

function updateSecurityEditMode() {
  const select = document.getElementById("security-question-select");
  const custom = document.getElementById("security-question-custom");
  const answer = document.getElementById("security-answer-input");
  [select, custom, answer].forEach((input) => {
    if (!input) return;
    input.disabled = false;
    input.classList.remove("opacity-60");
  });
  syncSecurityQuestionInputs(currentProfile?.security_question || "");
}

function updateSecurityQuestionPrompts(profile = currentProfile) {
  const enabled = Boolean(profile?.two_step_enabled);
  const question = normalizeSecurityText(profile?.security_question);
  const hasQuestion = Boolean(profile?.has_security_question && question);

  const statusLabel = document.getElementById("security-status-label");
  const currentQuestion = document.getElementById("security-current-question");
  const passwordWrap = document.getElementById(
    "profile-password-security-wrap",
  );
  const passwordQuestion = document.getElementById(
    "profile-password-security-question",
  );
  const deleteWrap = document.getElementById("delete-account-security-wrap");
  const deleteQuestion = document.getElementById(
    "delete-account-security-question",
  );

  if (statusLabel)
    statusLabel.innerText = enabled
      ? "2-Step Verification Enabled"
      : "2-Step Verification Disabled";
  if (currentQuestion)
    currentQuestion.innerText = hasQuestion
      ? question
      : "No security question saved yet.";
  if (passwordWrap)
    passwordWrap.classList.toggle("hidden", !enabled || !hasQuestion);
  if (passwordQuestion) passwordQuestion.innerText = question;
  if (deleteWrap)
    deleteWrap.classList.toggle("hidden", !enabled || !hasQuestion);
  if (deleteQuestion) deleteQuestion.innerText = question;
}

function updateTwoStepDisablePrompt(profile = currentProfile) {
  const disableWrap = document.getElementById("two-step-disable-password-wrap");
  const passwordInput = document.getElementById("two-step-current-password");
  const toggle = document.getElementById("two-step-enabled");
  if (!disableWrap || !toggle) return;

  const shouldRequirePassword =
    Boolean(profile?.two_step_enabled) && !toggle.checked;
  disableWrap.classList.toggle("hidden", !shouldRequirePassword);
  if (!shouldRequirePassword && passwordInput) {
    passwordInput.value = "";
  }
}

function showTwoStepFeedback(message, type = "success") {
  const feedback = document.getElementById("two-step-feedback");
  if (!feedback) return;

  feedback.innerText = message;
  feedback.classList.remove(
    "hidden",
    "border-emerald-200",
    "bg-emerald-50",
    "text-emerald-700",
    "border-red-200",
    "bg-red-50",
    "text-red-700",
  );

  if (type === "error") {
    feedback.classList.add("border-red-200", "bg-red-50", "text-red-700");
    return;
  }

  feedback.classList.add(
    "border-emerald-200",
    "bg-emerald-50",
    "text-emerald-700",
  );
}

function updateProfilePictureStatus(text) {
  const pictureLabel = document.getElementById("profile-picture-label");
  if (pictureLabel) pictureLabel.innerText = text;
}

function setLoginSubmitting(isSubmitting) {
  const button = document.getElementById("login-btn");
  const text = document.getElementById("login-text");
  const loader = document.getElementById("login-loader");
  if (button) button.disabled = isSubmitting;
  if (text) text.classList.toggle("hidden", isSubmitting);
  if (loader) loader.classList.toggle("hidden", !isSubmitting);
}

function setSecurityQuestionSubmitting(isSubmitting) {
  const button = document.getElementById("security-question-btn");
  const text = document.getElementById("security-question-btn-text");
  const answerInput = document.getElementById("security-answer");
  if (button) button.disabled = isSubmitting;
  if (answerInput) answerInput.disabled = isSubmitting;
  if (text) text.innerText = isSubmitting ? "Verifying..." : "Verify Answer";
}

function getProfilePreviewLabel() {
  const typedName = document.getElementById("profile-name")?.value;
  return (
    typedName ||
    getDisplayName() ||
    localStorage.getItem("user_email") ||
    "V-Loop"
  );
}

function restoreSavedProfilePicturePreview() {
  const pictureUrl = toAbsoluteMediaUrl(
    currentProfile?.profile_picture_url || "",
  );
  const label = getProfilePreviewLabel();
  setAvatar(
    "profile-avatar-image",
    "profile-avatar-fallback",
    pictureUrl,
    label,
  );
  setAvatar("nav-avatar-image", "nav-avatar-fallback", pictureUrl, label);
}

function clearProfilePictureSelection() {
  const input = document.getElementById("profile-picture-input");
  const hadSelectedFile = Boolean(input?.files?.length);
  const hasSavedPicture = Boolean(currentProfile?.profile_picture_url);
  if (input) input.value = "";

  if (hadSelectedFile) {
    pendingProfilePictureRemoval = false;
    restoreSavedProfilePicturePreview();
    updateProfilePictureStatus(
      hasSavedPicture ? "Saved photo restored." : "No photo uploaded yet.",
    );
    return;
  }

  pendingProfilePictureRemoval = hasSavedPicture;
  if (pendingProfilePictureRemoval) {
    const label = getProfilePreviewLabel();
    setAvatar("profile-avatar-image", "profile-avatar-fallback", "", label);
    setAvatar("nav-avatar-image", "nav-avatar-fallback", "", label);
    updateProfilePictureStatus("Photo will be removed when you save.");
    return;
  }

  restoreSavedProfilePicturePreview();
  updateProfilePictureStatus("No photo uploaded yet.");
}

function getMessageStateSignature(messages) {
  return [...(messages || [])]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((message) =>
      [
        Number(message.id),
        Number(message.sender),
        Number(message.receiver),
        message.timestamp || "",
        message.status || "",
        message.delivered_at || "",
        message.seen_at || "",
        message.deleted_for_everyone ? "1" : "0",
        message.deleted_at || "",
        message.display_content || message.content || "",
        message.attachment_url || "",
        message.attachment_name || "",
        message.reply_to_id || "",
        message.forwarded_from_id || "",
      ].join("~"),
    )
    .join("||");
}

function getConversationListRenderSignature(conversations) {
  return [
    normalizeSearchText(conversationSearchQuery),
    currentChatUserId || "",
    ...conversations.map((conversation) =>
      [
        Number(conversation.userId),
        conversation.email || "",
        conversation.name || "",
        conversation.avatar || "",
        conversation.isOnline ? "1" : "0",
        conversation.lastSeenAt || "",
        conversation.statusText || "",
        conversation.lastMessage || "",
        conversation.lastMessageStatus || "",
        conversation.lastSenderId || "",
        Number(conversation.unreadCount || 0),
        conversation.timestamp || "",
      ].join("~"),
    ),
  ].join("||");
}

function getCurrentConversationRenderSignature(
  messages,
  allConversationMessages,
) {
  return [
    currentChatUserId || "",
    currentChatUserEmail || "",
    currentChatUserName || "",
    currentChatUserAvatar || "",
    currentChatUserStatus || "",
    normalizeSearchText(messageSearchQuery),
    openMessageMenuId || "",
    replyingToMessage?.id || "",
    activeTypingUserId || "",
    String(hasLoadedMessagesOnce),
    String(messages.length),
    String(allConversationMessages.length),
    getMessageStateSignature(messages),
  ].join("||");
}

function bindNotificationPermissionPrompt() {
  const requestPermission = () => {
    if (!("Notification" in window) || Notification.permission !== "default")
      return;
    Notification.requestPermission().catch(() => null);
  };

  document.addEventListener("click", requestPermission, { once: true });
  document.addEventListener("keydown", requestPermission, { once: true });
}

function rememberNotifiedMessage(messageId) {
  const numericId = Number(messageId);
  if (!numericId) return;
  if (notifiedMessageIds.includes(numericId)) return;
  notifiedMessageIds.push(numericId);
  if (notifiedMessageIds.length > 250) {
    notifiedMessageIds = notifiedMessageIds.slice(-250);
  }
}

function hasNotifiedMessage(messageId) {
  const numericId = Number(messageId);
  return numericId ? notifiedMessageIds.includes(numericId) : false;
}

function getTotalUnreadChatCount() {
  return getConversationSummaries().reduce((total, conversation) => {
    return total + Number(conversation.unreadCount || 0);
  }, 0);
}

function renderChatButtonBadge() {
  const button = document.getElementById("chat-nav-button");
  const dot = document.getElementById("chat-nav-badge-dot");
  const count = document.getElementById("chat-nav-badge-count");
  if (!button || !dot || !count) return;

  const unreadCount = getTotalUnreadChatCount();
  const countLabel = unreadCount > 99 ? "99+" : String(unreadCount);
  const chatIsOpen = !document
    .getElementById("chat-section")
    ?.classList.contains("pointer-events-none");

  button.setAttribute(
    "aria-label",
    unreadCount > 0 ? `Chats, ${countLabel} unread messages` : "Chats",
  );

  if (unreadCount > 0) {
    dot.classList.remove("hidden");
    count.classList.remove("hidden");
    count.innerText = countLabel;
  } else {
    dot.classList.add("hidden");
    count.classList.add("hidden");
    count.innerText = "0";
  }

  dot.classList.toggle("animate-pulse", unreadCount > 0 && !chatIsOpen);
}

async function parseJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function getErrorMessage(data, fallback) {
  if (!data || typeof data !== "object") return fallback;
  if (typeof data.error === "string" && data.error.trim()) return data.error;

  const messages = Object.values(data)
    .flat()
    .filter((value) => typeof value === "string" && value.trim());
  return messages[0] || fallback;
}

function storeSession(data) {
  if (!data?.access || !data?.email || !data?.id) return false;
  const previousUserId = localStorage.getItem("user_id");
  clearPersistedChatUiStateForUser(previousUserId);
  clearPersistedChatUiStateForUser(data.id);
  clearPersistedChatUiStateForUser("guest");
  pendingChatUiRestore = null;
  localStorage.setItem("access_token", data.access);
  localStorage.setItem("user_email", data.email);
  localStorage.setItem("user_id", String(data.id));
  if (data.user) currentProfile = data.user;
  return true;
}

function getDisplayName(profile = currentProfile) {
  if (!profile) return "";
  return (
    profile.full_name ||
    [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim() ||
    profile.email.split("@")[0]
  );
}

function getEmailLabel(email) {
  const safeEmail = String(email || "").trim();
  return safeEmail ? safeEmail.split("@")[0] : "Campus user";
}

function getUserLabel(displayName, email) {
  return String(displayName || "").trim() || getEmailLabel(email);
}

function splitFullName(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
  };
}

function toAbsoluteMediaUrl(url) {
  if (!url) return "";
  if (String(url).startsWith("http")) return url;
  return `http://127.0.0.1:8000${url}`;
}

function applyChatTheme() {
  const shell = document.getElementById("chat-thread-shell");
  if (!shell) return;
  if (chatTheme === "dark") {
    shell.classList.remove("bg-[#F8FAF8]");
    shell.classList.add("bg-[#111614]");
    document.getElementById("chat-messages")?.classList.remove("bg-[#F8FAF8]");
    document.getElementById("chat-messages")?.classList.add("bg-[#111614]");
  } else {
    shell.classList.add("bg-[#F8FAF8]");
    shell.classList.remove("bg-[#111614]");
    document.getElementById("chat-messages")?.classList.add("bg-[#F8FAF8]");
    document.getElementById("chat-messages")?.classList.remove("bg-[#111614]");
  }
}

function toggleChatTheme() {
  chatTheme = chatTheme === "dark" ? "light" : "dark";
  localStorage.setItem("chat_theme", chatTheme);
  applyChatTheme();
  renderCurrentConversation();
}

function formatLastSeen(dateString) {
  if (!dateString) return "Offline";
  const date = new Date(dateString);
  return `Last seen ${date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

function formatConversationTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isNearBottom(container, threshold = 72) {
  if (!container) return true;
  return (
    container.scrollHeight - container.scrollTop - container.clientHeight <=
    threshold
  );
}

function autoResizeChatInput() {
  const input = document.getElementById("chat-input");
  if (!input) return;
  input.style.height = "auto";
  const nextHeight = Math.min(input.scrollHeight, 128);
  input.style.height = `${Math.max(nextHeight, 48)}px`;
  input.style.overflowY = input.scrollHeight > 128 ? "auto" : "hidden";
}

function resetChatInput() {
  const input = document.getElementById("chat-input");
  if (!input) return;
  input.value = "";
  autoResizeChatInput();
}

function focusChatInput() {
  const input = document.getElementById("chat-input");
  if (!input || input.disabled) return;
  window.requestAnimationFrame(() => input.focus());
}

function toggleMessageSearch(forceOpen = null) {
  const bar = document.getElementById("message-search-bar");
  const input = document.getElementById("message-search");
  if (!bar || !input) return;

  const shouldOpen =
    forceOpen === null ? bar.classList.contains("hidden") : Boolean(forceOpen);
  if (shouldOpen) {
    bar.classList.remove("hidden");
    input.focus();
    return;
  }

  bar.classList.add("hidden");
  if (messageSearchQuery) {
    messageSearchQuery = "";
    input.value = "";
    renderCurrentConversation();
  }
}

function setChatComposerEnabled(enabled) {
  const input = document.getElementById("chat-input");
  const sendButton = document.getElementById("chat-send-button");
  const emojiButton = document.getElementById("chat-emoji-toggle");
  const attachmentButton = document.getElementById("chat-attachment-button");
  const searchButton = document.getElementById("chat-search-button");

  if (input) {
    input.disabled = !enabled;
    input.placeholder = enabled
      ? "Type a message..."
      : "Select a conversation to send a message";
  }

  [sendButton, emojiButton, attachmentButton, searchButton].forEach(
    (button) => {
      if (!button) return;
      button.disabled = !enabled;
      button.classList.toggle("opacity-50", !enabled);
      button.classList.toggle("cursor-not-allowed", !enabled);
    },
  );
}

function toggleMessageMenu(messageId) {
  openMessageMenuId =
    openMessageMenuId === Number(messageId) ? null : Number(messageId);
  lastConversationThreadRenderSignature = "";
  renderCurrentConversation();
}

function messageMatchesSearch(message) {
  if (!messageSearchQuery) return true;
  const haystack = [
    message.display_content,
    message.content,
    message.attachment_name,
    message.reply_preview?.content,
    message.forwarded_preview?.content,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(messageSearchQuery);
}

function getMessageStatusLabel(message, isMe) {
  if (!isMe) return "";
  if (message.status === "seen" || message.seen_at) return "Seen";
  if (message.status === "delivered" || message.delivered_at) return "✓✓";
  return "✓";
}

function getInitials(text) {
  const name = String(text || "").trim();
  if (!name) return "V";
  const parts = name.split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() || "").join("") || "V";
}

function setAvatar(imageId, fallbackId, imageUrl, label) {
  const image = document.getElementById(imageId);
  const fallback = document.getElementById(fallbackId);
  if (!image || !fallback) return;

  const absoluteUrl = toAbsoluteMediaUrl(imageUrl);
  if (absoluteUrl) {
    image.src = absoluteUrl;
    image.classList.remove("hidden");
    fallback.classList.add("hidden");
    return;
  }

  fallback.innerText = getInitials(label);
  fallback.classList.remove("hidden");
  image.classList.add("hidden");
}

function getKnownConversationsStorageKey() {
  const userId = localStorage.getItem("user_id") || "guest";
  return `${KNOWN_CONVERSATIONS_STORAGE_KEY_PREFIX}_${userId}`;
}

function getChatUiStateStorageKey() {
  const userId = localStorage.getItem("user_id") || "guest";
  return `${CHAT_UI_STATE_STORAGE_KEY_PREFIX}_${userId}`;
}

function getChatUiStateStorageKeyForUser(userId) {
  return `${CHAT_UI_STATE_STORAGE_KEY_PREFIX}_${userId || "guest"}`;
}

function persistKnownConversations() {
  try {
    const payload = Array.from(knownConversations.values());
    localStorage.setItem(
      getKnownConversationsStorageKey(),
      JSON.stringify(payload),
    );
  } catch (error) {
    console.error("Could not persist known conversations.", error);
  }
}

function loadKnownConversationsCache() {
  try {
    const raw = localStorage.getItem(getKnownConversationsStorageKey());
    if (!raw) return;
    const cached = JSON.parse(raw);
    if (!Array.isArray(cached)) return;

    knownConversations = new Map(
      cached
        .filter((entry) => entry && entry.userId && entry.email)
        .map((entry) => [
          Number(entry.userId),
          {
            userId: Number(entry.userId),
            email: entry.email,
            name: entry.name || getEmailLabel(entry.email),
            avatar: toAbsoluteMediaUrl(entry.avatar || ""),
            status: entry.status || "Offline",
            timestamp: entry.timestamp || new Date(0).toISOString(),
          },
        ]),
    );
  } catch (error) {
    console.error("Could not load known conversations cache.", error);
    knownConversations = new Map();
  }
}

function upsertKnownConversation(
  userId,
  email,
  name = "",
  avatar = "",
  status = "",
  timestamp = null,
) {
  const numericUserId = Number(userId);
  if (!numericUserId || !email) return;

  const existing = knownConversations.get(numericUserId) || {};
  knownConversations.set(numericUserId, {
    userId: numericUserId,
    email,
    name: name || existing.name || getEmailLabel(email),
    avatar: toAbsoluteMediaUrl(avatar || existing.avatar || ""),
    status: status || existing.status || "Offline",
    timestamp: timestamp || existing.timestamp || new Date(0).toISOString(),
  });
  persistKnownConversations();
}

function persistChatUiState(forceOpen = null) {
  try {
    const chatSection = document.getElementById("chat-section");
    const isOpen =
      forceOpen === null
        ? Boolean(
            chatSection &&
            !chatSection.classList.contains("pointer-events-none"),
          )
        : Boolean(forceOpen);
    const payload = {
      isOpen,
      userId: currentChatUserId ? Number(currentChatUserId) : null,
      email: currentChatUserEmail || "",
      name: currentChatUserName || "",
      avatar: currentChatUserAvatar || "",
      status: currentChatUserStatus || "",
    };
    sessionStorage.setItem(getChatUiStateStorageKey(), JSON.stringify(payload));
  } catch (error) {
    console.error("Could not persist chat UI state.", error);
  }
}

function loadPersistedChatUiState() {
  try {
    const raw = sessionStorage.getItem(getChatUiStateStorageKey());
    if (!raw) return null;

    const state = JSON.parse(raw);
    if (!state) return null;

    return {
      isOpen: !!state.isOpen,
      userId: state.userId ? Number(state.userId) : null,
      email: state.email || "",
      name: state.name || "",
      avatar: state.avatar || "",
      status: state.status || "",
    };
  } catch (error) {
    console.error("Could not load chat UI state.", error);
    return null;
  }
}

function clearPersistedChatUiState() {
  try {
    sessionStorage.removeItem(getChatUiStateStorageKey());
  } catch (error) {
    console.error("Could not clear chat UI state.", error);
  }
}

function clearPersistedChatUiStateForUser(userId) {
  try {
    sessionStorage.removeItem(getChatUiStateStorageKeyForUser(userId));
  } catch (error) {
    console.error("Could not clear chat UI state for user.", error);
  }
}

function primeChatUiFromPersistedState() {
  if (
    !pendingChatUiRestore?.isOpen ||
    !pendingChatUiRestore.userId ||
    !pendingChatUiRestore.email
  )
    return false;

  currentChatUserId = Number(pendingChatUiRestore.userId);
  currentChatUserEmail = pendingChatUiRestore.email;
  currentChatUserName =
    pendingChatUiRestore.name || getEmailLabel(pendingChatUiRestore.email);
  currentChatUserAvatar = toAbsoluteMediaUrl(pendingChatUiRestore.avatar || "");
  currentChatUserStatus = pendingChatUiRestore.status || "Offline";
  upsertKnownConversation(
    currentChatUserId,
    currentChatUserEmail,
    currentChatUserName,
    currentChatUserAvatar,
    currentChatUserStatus,
  );
  return true;
}

async function restorePersistedChatUiState() {
  if (!pendingChatUiRestore) return false;

  const state = pendingChatUiRestore;
  pendingChatUiRestore = null;

  if (state.userId && state.email) {
    currentChatUserId = Number(state.userId);
    currentChatUserEmail = state.email;
    currentChatUserName = state.name || getEmailLabel(state.email);
    currentChatUserAvatar = toAbsoluteMediaUrl(state.avatar || "");
    currentChatUserStatus = state.status || "Offline";
    upsertKnownConversation(
      currentChatUserId,
      currentChatUserEmail,
      currentChatUserName,
      currentChatUserAvatar,
      currentChatUserStatus,
    );
  }

  // Always start with chat closed, this avoids auto-opening on refresh
  isChatOpenExplicitly = false;

  renderConversationList();
  renderCurrentConversation();
  return true;
}

function formatMemberSince(dateString) {
  if (!dateString) return "";
  return new Date(dateString).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function renderProfile(profile) {
  currentProfile = profile;
  pendingProfilePictureRemoval = false;
  const displayName = getDisplayName(profile);
  const pictureUrl = toAbsoluteMediaUrl(profile.profile_picture_url || "");

  const nameInput = document.getElementById("profile-name");
  const phoneNumber = document.getElementById("profile-phone-number");
  const email = document.getElementById("profile-email");
  const memberSince = document.getElementById("profile-member-since");
  const heading = document.getElementById("profile-name-heading");
  const emailHeading = document.getElementById("profile-email-heading");
  const twoStep = document.getElementById("two-step-enabled");
  const pictureLabel = document.getElementById("profile-picture-label");

  if (nameInput) nameInput.value = profile.full_name || "";
  if (phoneNumber) phoneNumber.value = profile.phone_number || "";
  if (email) email.value = profile.email || "";
  if (memberSince) memberSince.value = formatMemberSince(profile.date_joined);
  if (heading)
    heading.innerText = profile.full_name || profile.email || "Your account";
  if (emailHeading) emailHeading.innerText = profile.email || "";
  if (twoStep) twoStep.checked = Boolean(profile.two_step_enabled);
  if (pictureLabel)
    pictureLabel.innerText = profile.profile_picture_url
      ? "Saved photo on account."
      : "No photo uploaded yet.";

  syncSecurityQuestionInputs(profile.security_question || "");
  updateSecurityQuestionPrompts(profile);
  updateSecurityEditMode();
  updateTwoStepDisablePrompt(profile);

  const securityAnswerInput = document.getElementById("security-answer-input");
  const profilePasswordSecurityAnswer = document.getElementById(
    "profile-password-security-answer",
  );
  const deleteAccountSecurityAnswer = document.getElementById(
    "delete-account-security-answer",
  );
  const twoStepCurrentPassword = document.getElementById(
    "two-step-current-password",
  );
  const twoStepFeedback = document.getElementById("two-step-feedback");
  if (securityAnswerInput) securityAnswerInput.value = "";
  if (profilePasswordSecurityAnswer) profilePasswordSecurityAnswer.value = "";
  if (deleteAccountSecurityAnswer) deleteAccountSecurityAnswer.value = "";
  if (twoStepCurrentPassword) twoStepCurrentPassword.value = "";
  if (twoStepFeedback) twoStepFeedback.classList.add("hidden");

  setAvatar(
    "nav-avatar-image",
    "nav-avatar-fallback",
    pictureUrl,
    displayName || profile.email,
  );
  setAvatar(
    "profile-avatar-image",
    "profile-avatar-fallback",
    pictureUrl,
    displayName || profile.email,
  );
}

async function loadProfile() {
  const token = localStorage.getItem("access_token");
  if (!token) return;

  try {
    const response = await fetch(`${API_URL}/profile/`, {
      headers: getHeaders(false),
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(getErrorMessage(data, "Could not load profile."));
    }
    renderProfile(data);
  } catch (error) {
    console.error(error);
  }
}

function openProfileModal() {
  if (!requireAuth("Please login to view your profile.")) return;
  document.getElementById("profile-modal")?.classList.remove("hidden");
  if (currentProfile) {
    renderProfile(currentProfile);
  } else {
    loadProfile();
  }
}

function closeProfileModal() {
  document.getElementById("profile-modal")?.classList.add("hidden");
}

function resetSecurityQuestionState() {
  pendingSecurityChallengeToken = "";
  pendingSecurityQuestion = "";
  securityQuestionRequestInFlight = false;
  const answerInput = document.getElementById("security-answer");
  if (answerInput) answerInput.value = "";
  setSecurityQuestionSubmitting(false);
}

function showSecurityQuestionStep(question, challengeToken) {
  pendingSecurityChallengeToken = challengeToken;
  pendingSecurityQuestion = question;
  document.getElementById("login-form")?.classList.add("hidden");
  document.getElementById("signup-form")?.classList.add("hidden");
  document.getElementById("security-question-form")?.classList.remove("hidden");
  const description = document.getElementById("security-question-description");
  const text = document.getElementById("security-question-text");
  if (description)
    description.innerText = "Answer your security question to complete login.";
  if (text) text.innerText = question || "Security question unavailable.";
  setSecurityQuestionSubmitting(false);
  document.getElementById("security-answer")?.focus();
}

function toggleEmojiPicker() {
  document.getElementById("emoji-picker")?.classList.toggle("hidden");
}

function addEmoji(emoji) {
  const input = document.getElementById("chat-input");
  if (!input) return;
  input.value += emoji;
  input.focus();
  sendTypingState(true);
  document.getElementById("emoji-picker")?.classList.add("hidden");
}

function openChatAttachmentPicker() {
  document.getElementById("chat-attachment-input")?.click();
}

function handleChatAttachmentChange(event) {
  pendingChatAttachment = event.target.files?.[0] || null;
  const preview = document.getElementById("chat-attachment-preview");
  const name = document.getElementById("chat-attachment-name");
  if (!preview || !name) return;

  if (!pendingChatAttachment) {
    preview.classList.add("hidden");
    name.innerText = "";
    return;
  }

  name.innerText = pendingChatAttachment.name;
  preview.classList.remove("hidden");
}

function clearChatAttachment() {
  pendingChatAttachment = null;
  const input = document.getElementById("chat-attachment-input");
  if (input) input.value = "";
  document.getElementById("chat-attachment-preview")?.classList.add("hidden");
  const name = document.getElementById("chat-attachment-name");
  if (name) name.innerText = "";
}

function setReplyTarget(messageId) {
  const message = allMessages.find(
    (entry) => Number(entry.id) === Number(messageId),
  );
  if (!message) return;
  replyingToMessage = message;
  const bar = document.getElementById("chat-reply-bar");
  const text = document.getElementById("chat-reply-text");
  if (bar && text) {
    text.innerText =
      message.display_content ||
      message.content ||
      message.attachment_name ||
      "Attachment";
    bar.classList.remove("hidden");
  }
  lastConversationThreadRenderSignature = "";
  document.getElementById("chat-input")?.focus();
}

function clearReplyTarget() {
  replyingToMessage = null;
  document.getElementById("chat-reply-bar")?.classList.add("hidden");
  const text = document.getElementById("chat-reply-text");
  if (text) text.innerText = "";
  lastConversationThreadRenderSignature = "";
}

function clearForwardTarget() {
  forwardingMessage = null;
  forwardSearchQuery = "";
}

function getForwardPreviewText(message = forwardingMessage) {
  if (!message) return "";
  if (message.deleted_for_everyone)
    return "Deleted messages cannot be forwarded.";
  return (
    message.display_content ||
    message.content ||
    message.attachment_name ||
    "Attachment"
  );
}

function getForwardRecipients() {
  const currentUserId = Number(localStorage.getItem("user_id"));
  const map = new Map();

  getConversationSummaries().forEach((conversation) => {
    if (!conversation.userId || Number(conversation.userId) === currentUserId)
      return;
    map.set(Number(conversation.userId), {
      userId: Number(conversation.userId),
      email: conversation.email,
      name: conversation.name || getEmailLabel(conversation.email),
      avatar: conversation.avatar || "",
      subtitle: conversation.isOnline
        ? "Online now"
        : formatLastSeen(conversation.lastSeenAt),
    });
  });

  allItems.forEach((item) => {
    const ownerId = Number(item.owner);
    if (!ownerId || ownerId === currentUserId) return;
    if (map.has(ownerId)) return;
    map.set(ownerId, {
      userId: ownerId,
      email: item.owner_email,
      name: getUserLabel(item.owner_display_name, item.owner_email),
      avatar: toAbsoluteMediaUrl(item.owner_profile_picture_url || ""),
      subtitle: `${item.type} · ${item.category}`,
    });
  });

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function renderForwardRecipientList() {
  const container = document.getElementById("forward-recipient-list");
  if (!container) return;

  const recipients = getForwardRecipients().filter((recipient) => {
    if (!forwardSearchQuery) return true;
    const haystack = [recipient.name, recipient.email, recipient.subtitle]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(forwardSearchQuery);
  });

  if (recipients.length === 0) {
    container.innerHTML = `<div class="p-4 text-sm text-gray-500">No matching users found.</div>`;
    return;
  }

  container.innerHTML = recipients
    .map(
      (recipient) => `
        <button
            type="button"
            data-forward-user-id="${recipient.userId}"
            data-forward-email="${escapeHtml(recipient.email)}"
            data-forward-name="${escapeHtml(recipient.name)}"
            data-forward-avatar="${escapeHtml(recipient.avatar)}"
            class="flex w-full items-center gap-3 border-b border-vloop-sage/40 px-4 py-4 text-left transition hover:bg-white"
        >
            ${recipient.avatar ? `<img src="${recipient.avatar}" class="h-11 w-11 rounded-full object-cover border border-vloop-sage/40" alt="${escapeHtml(recipient.name)}">` : `<div class="h-11 w-11 rounded-full bg-vloop-dark text-white flex items-center justify-center text-xs font-bold">${getInitials(recipient.name)}</div>`}
            <div class="min-w-0 flex-1">
                <p class="font-semibold text-vloop-dark truncate">${escapeHtml(recipient.name)}</p>
                <p class="mt-1 text-xs text-gray-500 truncate">${escapeHtml(recipient.subtitle || recipient.email)}</p>
            </div>
            <span class="text-xs font-semibold text-vloop-base">Forward</span>
        </button>
    `,
    )
    .join("");

  container.querySelectorAll("[data-forward-user-id]").forEach((button) => {
    button.addEventListener("click", () => {
      forwardMessageToRecipient(
        Number(button.dataset.forwardUserId),
        button.dataset.forwardEmail || "",
        button.dataset.forwardName || "",
        button.dataset.forwardAvatar || "",
      );
    });
  });
}

function openForwardModal(messageId) {
  const message = allMessages.find(
    (entry) => Number(entry.id) === Number(messageId),
  );
  if (!message) return;
  if (message.deleted_for_everyone) {
    alert("Deleted messages cannot be forwarded.");
    return;
  }

  forwardingMessage = message;
  forwardSearchQuery = "";
  const preview = document.getElementById("forward-preview-text");
  const searchInput = document.getElementById("forward-search");
  if (preview) preview.innerText = getForwardPreviewText(message);
  if (searchInput) searchInput.value = "";
  renderForwardRecipientList();
  document.getElementById("forward-modal")?.classList.remove("hidden");
  searchInput?.focus();
}

function closeForwardModal() {
  document.getElementById("forward-modal")?.classList.add("hidden");
  clearForwardTarget();
}

function previewProfilePicture(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  pendingProfilePictureRemoval = false;
  const reader = new FileReader();
  reader.onload = () => {
    const typedName = document.getElementById("profile-name")?.value;
    const label =
      typedName ||
      getDisplayName() ||
      localStorage.getItem("user_email") ||
      "V-Loop";
    setAvatar(
      "profile-avatar-image",
      "profile-avatar-fallback",
      reader.result,
      label,
    );
    setAvatar("nav-avatar-image", "nav-avatar-fallback", reader.result, label);
  };
  updateProfilePictureStatus(file.name);
  reader.readAsDataURL(file);
}

async function saveProfile(event) {
  event.preventDefault();
  const formData = new FormData();
  const fullName = document.getElementById("profile-name")?.value || "";
  const { firstName, lastName } = splitFullName(fullName);
  formData.append("first_name", firstName);
  formData.append("last_name", lastName);
  formData.append(
    "phone_number",
    document.getElementById("profile-phone-number")?.value || "",
  );

  const profilePicture = document.getElementById("profile-picture-input")
    ?.files?.[0];
  if (profilePicture) formData.append("profile_picture", profilePicture);
  if (!profilePicture && pendingProfilePictureRemoval)
    formData.append("remove_profile_picture", "true");

  try {
    const response = await fetch(`${API_URL}/profile/`, {
      method: "PATCH",
      headers: getHeaders(false),
      body: formData,
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      alert(getErrorMessage(data, "Could not save profile."));
      return;
    }

    renderProfile(data);
    loadItems();
    loadMessages();
    alert("Profile updated.");
  } catch (error) {
    alert(SERVER_OFFLINE_MESSAGE);
  }
}

async function updateProfilePassword(event) {
  event.preventDefault();
  const currentPassword =
    document.getElementById("profile-current-password")?.value || "";
  const newPassword =
    document.getElementById("profile-new-password")?.value || "";
  const confirmPassword =
    document.getElementById("profile-confirm-password")?.value || "";
  const securityAnswer =
    document.getElementById("profile-password-security-answer")?.value || "";

  if (!currentPassword || !newPassword || !confirmPassword) {
    alert("Enter your current password and confirm the new one.");
    return;
  }

  if (newPassword !== confirmPassword) {
    alert("New passwords do not match.");
    return;
  }

  try {
    const response = await fetch(`${API_URL}/profile/password/`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
        confirm_password: confirmPassword,
        security_answer: securityAnswer,
      }),
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      alert(getErrorMessage(data, "Could not update password."));
      return;
    }

    document.getElementById("profile-password-form")?.reset();
    alert(data.message || "Password updated.");
  } catch (error) {
    alert(SERVER_OFFLINE_MESSAGE);
  }
}

async function saveTwoStepPreference(event) {
  event.preventDefault();
  const enabled = document.getElementById("two-step-enabled")?.checked;
  const securityQuestion = getSelectedSecurityQuestion();
  const securityAnswer =
    document.getElementById("security-answer-input")?.value || "";
  const currentPassword =
    document.getElementById("two-step-current-password")?.value || "";
  const currentQuestion = normalizeSecurityText(
    currentProfile?.security_question || "",
  );
  const questionChanged =
    normalizeSecurityText(securityQuestion) !== currentQuestion;
  const hasTypedAnswer = Boolean(normalizeSecurityText(securityAnswer));
  const shouldUpdateSavedQuestion = Boolean(
    questionChanged ||
    hasTypedAnswer ||
    (!currentProfile?.has_security_question && enabled),
  );
  const disablingTwoStep =
    Boolean(currentProfile?.two_step_enabled) && !enabled;

  if (disablingTwoStep && !currentPassword) {
    alert("Enter your current password to disable 2-step verification.");
    return;
  }

  if (shouldUpdateSavedQuestion) {
    if (!securityQuestion) {
      alert("Security question cannot be empty.");
      return;
    }
    if (normalizeSecurityText(securityAnswer).length < 3) {
      alert("Security answer must be at least 3 characters.");
      return;
    }
  }

  try {
    const response = await fetch(`${API_URL}/profile/two-step/`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        enabled,
        ...(disablingTwoStep ? { current_password: currentPassword } : {}),
        ...(shouldUpdateSavedQuestion
          ? {
              security_question: securityQuestion,
              security_answer: securityAnswer,
            }
          : {}),
      }),
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      showTwoStepFeedback(
        getErrorMessage(data, "Could not update 2-step verification."),
        "error",
      );
      alert(getErrorMessage(data, "Could not update 2-step verification."));
      return;
    }

    if (currentProfile) {
      currentProfile.two_step_enabled = Boolean(data.two_step_enabled);
      currentProfile.security_question =
        data.security_question || currentProfile.security_question || "";
      currentProfile.has_security_question = Boolean(
        data.has_security_question,
      );
    }
    renderProfile({
      ...(currentProfile || {}),
      ...data,
      has_security_question: Boolean(data.has_security_question),
    });
    showTwoStepFeedback(
      disablingTwoStep
        ? "2-Step Verification Disabled"
        : data.message || "Security setting updated.",
      "success",
    );
    alert(data.message || "Security setting updated.");
  } catch (error) {
    showTwoStepFeedback(SERVER_OFFLINE_MESSAGE, "error");
    alert(SERVER_OFFLINE_MESSAGE);
  }
}

async function deleteAccount(event) {
  event?.preventDefault();
  const currentPassword =
    document.getElementById("delete-account-password")?.value || "";
  const securityAnswer =
    document.getElementById("delete-account-security-answer")?.value || "";

  if (!currentPassword) {
    alert("Enter your current password to delete the account.");
    return;
  }

  showConfirmModal(
    "Delete your account permanently? This cannot be undone.",
    async () => {
      try {
        const response = await fetch(`${API_URL}/profile/delete-account/`, {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({
            current_password: currentPassword,
            security_answer: securityAnswer,
          }),
        });
        const data = await parseJsonResponse(response);
        if (!response.ok) {
          alert(getErrorMessage(data, "Could not delete your account."));
          return;
        }

        alert(data.message || "Your account has been deleted.");
        logout();
      } catch (error) {
        alert(SERVER_OFFLINE_MESSAGE);
      }
    },
  );
}

async function signup(event) {
  event?.preventDefault();
  const email = normalizeEmailValue(
    document.getElementById("signup-email").value,
  );
  const password = document.getElementById("signup-password").value;
  if (!email || !password) {
    alert("Enter your college email and password.");
    return;
  }
  if (!email.endsWith("@vidyaacademy.ac.in")) {
    alert("Please use your Vidya Academy email.");
    return;
  }
  try {
    const response = await fetch(`${API_URL}/register/`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ email, password }),
    });
    const data = await parseJsonResponse(response);
    if (response.ok) {
      if (storeSession(data)) {
        location.href = "listings.html";
        return;
      }

      alert("Registration successful! Please login.");
      location.href = "login.html";
    } else {
      alert(getErrorMessage(data, "Signup failed"));
    }
  } catch (e) {
    alert(SERVER_OFFLINE_MESSAGE);
  }
}

async function login(event) {
  event?.preventDefault();
  if (loginRequestInFlight) return;
  const email = normalizeEmailValue(document.getElementById("email").value);
  const password = document.getElementById("password").value;
  if (!email || !password) {
    alert("Enter your email and password.");
    return;
  }
  loginRequestInFlight = true;
  setLoginSubmitting(true);
  try {
    const response = await fetch(`${API_URL}/login/`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ email, password }),
    });
    const data = await parseJsonResponse(response);
    if (response.status === 202 && data.security_question_required) {
      showSecurityQuestionStep(data.security_question, data.challenge_token);
      return;
    }
    if (response.ok && storeSession(data)) {
      location.href = "listings.html";
    } else {
      alert(getErrorMessage(data, "Login failed"));
    }
  } catch (e) {
    alert(SERVER_OFFLINE_MESSAGE);
  } finally {
    loginRequestInFlight = false;
    setLoginSubmitting(false);
  }
}

async function verifySecurityQuestion(event) {
  event?.preventDefault();
  if (securityQuestionRequestInFlight) return;
  const answer = String(
    document.getElementById("security-answer")?.value || "",
  ).trim();
  if (!pendingSecurityChallengeToken || !answer) {
    alert("Enter the answer to your security question.");
    return;
  }
  securityQuestionRequestInFlight = true;
  setSecurityQuestionSubmitting(true);

  try {
    const response = await fetch(`${API_URL}/login/verify-security-question/`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        challenge_token: pendingSecurityChallengeToken,
        answer,
      }),
    });
    const data = await parseJsonResponse(response);
    if (response.ok && storeSession(data)) {
      resetSecurityQuestionState();
      location.href = "listings.html";
      return;
    }

    alert(getErrorMessage(data, "Incorrect answer."));
  } catch (error) {
    alert(SERVER_OFFLINE_MESSAGE);
  } finally {
    securityQuestionRequestInFlight = false;
    setSecurityQuestionSubmitting(false);
  }
}

async function forgotPassword() {
  const emailInput = document.getElementById("forgot-email");
  const email = normalizeEmailValue(emailInput?.value);
  if (!email) {
    alert("Enter your email to reset your password.");
    return;
  }

  try {
    const response = await fetch(`${API_URL}/forgot-password/`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ email }),
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      alert(getErrorMessage(data, "Could not send reset link."));
      return;
    }

    alert(data.message || "Password reset email sent.");
    if (typeof hideForgotModal === "function") hideForgotModal();
    if (emailInput) emailInput.value = "";
  } catch (e) {
    alert(SERVER_OFFLINE_MESSAGE);
  }
}

function logout() {
  if (chatSocket) chatSocket.close();
  closeProfileModal();
  resetSecurityQuestionState();
  clearPersistedChatUiState();
  localStorage.clear();
  location.href = "login.html";
}

async function loadItems() {
  try {
    const res = await fetch(`${API_URL}/items/`);
    if (!res.ok) throw new Error("Failed to fetch");
    allItems = await res.json();
    window.allItems = allItems;
    applyMarketplaceFilters();
  } catch (e) {
    console.error(e);
    const container = document.getElementById("items");
    if (container)
      container.innerHTML =
        "<p class='col-span-full text-center py-10'>Error loading items.</p>";
  }
}

function toggleChatPanel(show) {
  const chatSection = document.getElementById("chat-section");
  const nav = document.getElementById("marketplace-nav");
  const content = document.getElementById("marketplace-content");
  if (!chatSection) return;
  if (show && !requireAuth("Please login to access chats.")) return;

  if (show) {
    isChatOpenExplicitly = true;
    document.body.classList.add("overflow-hidden");
    nav?.classList.add("opacity-0", "pointer-events-none");
    content?.classList.add("opacity-0", "pointer-events-none");
    chatSection.classList.remove(
      "translate-x-full",
      "opacity-0",
      "pointer-events-none",
    );
    chatSection.classList.add(
      "translate-x-0",
      "opacity-100",
      "pointer-events-auto",
    );
    document.documentElement.classList.remove("chat-boot-open");
    persistChatUiState(true);
    lastConversationListRenderSignature = "";
    lastConversationThreadRenderSignature = "";
    renderChatButtonBadge();
    const conversations = getConversationSummaries();
    if (!currentChatUserId && conversations.length > 0) {
      selectConversation(conversations[0].userId, conversations[0].email);
    } else {
      renderCurrentConversation();
      window.setTimeout(() => focusChatInput(), 220);
    }
  } else {
    isChatOpenExplicitly = false;
    document.documentElement.classList.remove("chat-boot-open");
    chatSection.classList.remove(
      "translate-x-0",
      "opacity-100",
      "pointer-events-auto",
    );
    chatSection.classList.add(
      "translate-x-full",
      "opacity-0",
      "pointer-events-none",
    );
    nav?.classList.remove("opacity-0", "pointer-events-none");
    content?.classList.remove("opacity-0", "pointer-events-none");
    document.body.classList.remove("overflow-hidden");
    toggleMessageSearch(false);
    persistChatUiState(false);
    renderChatButtonBadge();
  }
}

async function clearActiveConversation() {
  if (!currentChatUserId || !currentChatUserEmail) {
    alert("Select a conversation first.");
    return;
  }

  const partnerId = Number(currentChatUserId);
  const partnerEmail = currentChatUserEmail;

  showConfirmModal(`Clear your chat with ${partnerEmail}?`, async () => {
    try {
      const response = await fetch(`${API_URL}/messages/clear-chat/`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ partner_id: partnerId }),
      });
      const data = await parseJsonResponse(response);
      if (!response.ok) {
        alert(getErrorMessage(data, "Could not clear chat."));
        return;
      }

      const currentUserId = Number(localStorage.getItem("user_id"));
      allMessages = allMessages.filter(
        (message) =>
          !(
            (message.sender === currentUserId &&
              message.receiver === partnerId) ||
            (message.receiver === currentUserId && message.sender === partnerId)
          ),
      );
      conversationSummaries = conversationSummaries.filter(
        (conversation) => Number(conversation.userId) !== partnerId,
      );
      knownConversations.delete(partnerId);
      persistKnownConversations();
      currentChatUserId = null;
      currentChatUserEmail = null;
      currentChatUserName = null;
      currentChatUserAvatar = "";
      currentChatUserStatus = "";
      persistChatUiState(true);
      renderConversationList();
      renderCurrentConversation();
      updateTypingIndicator("");
    } catch (error) {
      alert(SERVER_OFFLINE_MESSAGE);
    }
  });
}

async function loadMessages(
  preferredPartnerId = null,
  preferredPartnerEmail = null,
) {
  const token = localStorage.getItem("access_token");
  if (!token) return;

  try {
    const [res] = await Promise.all([
      fetch(`${API_URL}/messages/`, {
        headers: getHeaders(false),
      }),
      loadConversationSummaries(),
    ]);
    if (!res.ok) throw new Error("Failed to fetch messages");

    const fetchedMessages = await res.json();
    const messagesChanged = syncFetchedMessages(
      fetchedMessages,
      hasLoadedMessagesOnce,
    );
    hasLoadedMessagesOnce = true;
    renderConversationList();

    if (preferredPartnerId && preferredPartnerEmail) {
      selectConversation(preferredPartnerId, preferredPartnerEmail);
      return;
    }

    if (currentChatUserId && currentChatUserEmail) {
      const socketActive =
        chatSocket &&
        chatSocketReceiverId === Number(currentChatUserId) &&
        (chatSocket.readyState === WebSocket.OPEN ||
          chatSocket.readyState === WebSocket.CONNECTING);

      if (!socketActive) {
        connectChatSocket(currentChatUserId);
        await refreshActiveConversation();
      } else if (messagesChanged) {
        renderCurrentConversation();
      }
      return;
    }

    if (isChatOpenExplicitly) {
      const conversations = getConversationSummaries();
      if (conversations.length > 0) {
        selectConversation(conversations[0].userId, conversations[0].email);
      }
    }
  } catch (e) {
    console.error(e);
  }
}

function syncFetchedMessages(messages, shouldNotify) {
  const previousSignature = getMessageStateSignature(allMessages);
  const previousIds = new Set(allMessages.map((message) => Number(message.id)));
  const normalizedMessages = messages.map((message) =>
    normalizeMessage(message),
  );
  const hasChanged =
    previousSignature !== getMessageStateSignature(normalizedMessages);
  allMessages = normalizedMessages;

  normalizedMessages.forEach((message) => {
    const currentUserId = Number(localStorage.getItem("user_id"));
    const partnerId =
      message.sender === currentUserId ? message.receiver : message.sender;
    const partnerEmail =
      message.sender === currentUserId
        ? message.receiver_email
        : message.sender_email;
    const partnerName =
      message.sender === currentUserId
        ? message.receiver_display_name
        : message.sender_display_name;
    const partnerAvatar =
      message.sender === currentUserId
        ? message.receiver_profile_picture_url
        : message.sender_profile_picture_url;
    const partnerOnline =
      message.sender === currentUserId
        ? message.receiver_is_online
        : message.sender_is_online;
    const partnerLastSeen =
      message.sender === currentUserId
        ? message.receiver_last_seen_at
        : message.sender_last_seen_at;
    upsertKnownConversation(
      partnerId,
      partnerEmail,
      partnerName,
      partnerAvatar,
      partnerOnline ? "Online" : formatLastSeen(partnerLastSeen),
      message.timestamp,
    );
  });

  if (!shouldNotify) return hasChanged;

  normalizedMessages.forEach((message) => {
    const isNew = !previousIds.has(Number(message.id));
    const isIncoming =
      Number(message.sender) !== Number(localStorage.getItem("user_id"));
    if (isNew && isIncoming) {
      maybeNotifyAboutMessage(message);
    }
  });

  return hasChanged;
}

async function loadConversationSummaries() {
  const token = localStorage.getItem("access_token");
  if (!token) {
    conversationSummaries = [];
    return [];
  }

  try {
    const res = await fetch(`${API_URL}/messages/conversations/`, {
      headers: getHeaders(false),
    });
    if (!res.ok) throw new Error("Failed to fetch conversations");

    const data = await res.json();
    conversationSummaries = data.map((conversation) => {
      const normalized = {
        userId: Number(conversation.user_id),
        email: conversation.email,
        name: conversation.display_name || getEmailLabel(conversation.email),
        avatar: toAbsoluteMediaUrl(conversation.profile_picture_url || ""),
        isOnline: Boolean(conversation.is_online),
        lastSeenAt: conversation.last_seen_at || null,
        statusText: null,
        lastMessage: conversation.last_message || "Open chat",
        lastMessageStatus: conversation.last_message_status || "",
        lastSenderId: conversation.last_sender_id ?? null,
        unreadCount: Number(conversation.unread_count || 0),
        timestamp: conversation.timestamp || new Date(0).toISOString(),
      };
      upsertKnownConversation(
        normalized.userId,
        normalized.email,
        normalized.name,
        normalized.avatar,
        normalized.isOnline ? "Online" : formatLastSeen(normalized.lastSeenAt),
        normalized.timestamp,
      );
      return normalized;
    });
    return conversationSummaries;
  } catch (error) {
    console.error(error);
    return conversationSummaries;
  }
}

function renderItems(items) {
  const container = document.getElementById("items");
  if (!container) return;
  container.innerHTML = "";

  const isAuthenticated = hasActiveSession();
  const currentUserEmail = isAuthenticated
    ? localStorage.getItem("user_email")
    : "";
  if (items.length === 0) {
    container.innerHTML =
      "<p class='col-span-full text-center py-20 text-gray-500'>No items found matching your criteria.</p>";
    return;
  }

  items.forEach((item) => {
    const isOwner =
      (item.owner_email || "").toLowerCase() ===
      (currentUserEmail || "").toLowerCase();
    const imageUrl = item.image
      ? item.image.startsWith("http")
        ? item.image
        : `http://127.0.0.1:8000${item.image}`
      : "https://via.placeholder.com/400x300?text=V-Loop";
    const ownerLabel = getUserLabel(item.owner_display_name, item.owner_email);
    const ownerAvatar = toAbsoluteMediaUrl(
      item.owner_profile_picture_url || "",
    );
    const ownerInitials = getInitials(ownerLabel);

    const card = `
            <article class="marketplace-card">
                <div class="marketplace-card-media">
                    <img src="${imageUrl}" alt="${escapeHtml(item.title)}" class="marketplace-card-image">
                    <div class="marketplace-card-price">Rs ${item.price}</div>
                </div>
                <div class="marketplace-card-body">
                    <div class="marketplace-card-meta">
                        <span class="marketplace-card-type">${escapeHtml(item.type)}</span>
                        <span class="marketplace-card-category">${escapeHtml(item.category)}</span>
                    </div>
                    <h3 class="marketplace-card-title">${escapeHtml(item.title)}</h3>
                    <p class="marketplace-card-description">${escapeHtml(item.description)}</p>
                    <div class="marketplace-card-footer">
                        <div class="marketplace-owner">
                            ${ownerAvatar ? `<img src="${ownerAvatar}" class="marketplace-owner-avatar" alt="${escapeHtml(ownerLabel)}">` : `<div class="marketplace-owner-fallback">${ownerInitials}</div>`}
                            <div class="marketplace-owner-copy">
                                <p class="marketplace-owner-name">${escapeHtml(ownerLabel)}</p>
                                <p class="marketplace-owner-label">Campus member</p>
                            </div>
                        </div>
                        <div class="marketplace-card-actions">
                            ${
                              isAuthenticated && isOwner
                                ? `
                                <button type="button" onclick="editItem(${item.id})" class="marketplace-action">Edit</button>
                                <button type="button" onclick="deleteItem(${item.id})" class="marketplace-action marketplace-action-danger">Delete</button>
                            `
                                : isAuthenticated
                                  ? `
                                <button type="button" onclick='openChat(${item.owner}, ${JSON.stringify(item.owner_email)}, ${JSON.stringify(ownerLabel)}, ${JSON.stringify(ownerAvatar)})' class="marketplace-action marketplace-action-primary">Chat</button>
                            `
                                  : `
                                <span class="marketplace-card-status">Login to interact</span>
                            `
                            }
                        </div>
                    </div>
                </div>
            </article>
        `;
    container.innerHTML += card;
  });
}

function getFilteredItems() {
  return allItems.filter((item) => {
    const matchesType = currentFilter === "all" || item.type === currentFilter;
    if (!matchesType) return false;

    if (!currentSearchQuery) return true;

    const haystack = [
      item.title,
      item.description,
      item.category,
      item.owner_display_name,
      item.owner_email,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(currentSearchQuery);
  });
}

function applyMarketplaceFilters() {
  renderItems(getFilteredItems());
}

function searchItems() {
  currentSearchQuery = String(document.getElementById("search")?.value || "")
    .trim()
    .toLowerCase();
  applyMarketplaceFilters();
}

function filterItems(type, event) {
  currentFilter = type;
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.classList.remove("bg-vloop-dark", "text-white");
    btn.classList.add("bg-white", "text-vloop-dark");
  });
  const activeButton = event?.currentTarget || event?.target?.closest("button");
  if (activeButton) {
    activeButton.classList.replace("bg-white", "bg-vloop-dark");
    activeButton.classList.replace("text-vloop-dark", "text-white");
  }
  applyMarketplaceFilters();
}

let editIndex = -1;

function resetListingForm() {
  document.getElementById("title").value = "";
  document.getElementById("description").value = "";
  document.getElementById("price").value = "";
  document.getElementById("type").value = "Sell";
  document.getElementById("category").value = "Textbook";
  document.getElementById("image").value = "";
  document.getElementById("image-label").innerText =
    "Click to upload item photo";
}

function openModal() {
  if (!requireAuth("Please login to post an item.")) return;
  resetListingForm();
  document.getElementById("modal").classList.remove("hidden");
  document.getElementById("modal-title").innerText = "Post a New Item";
  document.getElementById("post-btn-text").innerText = "List Item";
  editIndex = -1;
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
  resetListingForm();
}

function updateListingImageLabel(event) {
  const selectedFile = event.target.files?.[0];
  document.getElementById("image-label").innerText =
    selectedFile?.name || "Click to upload item photo";
}

function handlePostItemSubmit(event) {
  event.preventDefault();
  postItem();
}

function handlePostItemFormKeydown(event) {
  if (event.key !== "Enter") return;

  const target = event.target;
  const tagName = target?.tagName?.toLowerCase();
  const inputType = String(target?.type || "").toLowerCase();
  const shouldAllowEnter =
    tagName === "textarea" || inputType === "submit" || inputType === "button";

  if (!shouldAllowEnter) {
    event.preventDefault();
  }
}

async function postItem() {
  if (!requireAuth("Please login to post an item.")) return;

  const title = document.getElementById("title").value.trim();
  const description = document.getElementById("description").value.trim();
  const type = document.getElementById("type").value;
  const category = document.getElementById("category").value;
  const priceValue = document.getElementById("price").value.trim();

  if (!title) {
    alert("Please enter a title.");
    return;
  }
  if (!description) {
    alert("Please enter a description.");
    return;
  }

  const formData = new FormData();
  formData.append("title", title);
  formData.append("description", description);
  formData.append("type", type);
  formData.append("category", category);

  if (priceValue !== "") {
    formData.append("price", priceValue);
  }

  const imageFile = document.getElementById("image").files[0];
  if (imageFile) {
    formData.append("image", imageFile);
  }

  try {
    const url =
      editIndex === -1 ? `${API_URL}/items/` : `${API_URL}/items/${editIndex}/`;
    const method = editIndex === -1 ? "POST" : "PATCH";
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${localStorage.getItem("access_token")}`,
      },
      body: formData,
    });

    if (response.ok) {
      closeModal();
      loadItems();
    } else {
      const errorData = await response.json().catch(() => null);
      console.error("Item post error", response.status, errorData);
      alert(
        `Action failed: ${errorData?.detail || errorData || `HTTP ${response.status}`}`,
      );
    }
  } catch (e) {
    console.error("Item post exception", e);
    alert("Error connecting to server.");
  }
}

async function deleteItem(id) {
  showConfirmModal("Are you sure you want to delete this item?", async () => {
    const token = localStorage.getItem("access_token");
    if (!token) {
      alert("Session expired. Please log in again.");
      location.href = "login.html";
      return;
    }

    try {
      const res = await fetch(`${API_URL}/items/${id}/`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 204 || res.ok) {
        alert("Item deleted successfully!");
        loadItems();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(
          `Delete failed (Status ${res.status}): ${data.error || JSON.stringify(data) || "Unknown error"}`,
        );
      }
    } catch (e) {
      console.error("Delete error:", e);
      alert(`Request failed: ${e.message}`);
    }
  });
}

let confirmCallback = null;
function showConfirmModal(message, callback) {
  const msgEl = document.getElementById("confirm-message");
  const modalEl = document.getElementById("confirm-modal");
  if (!msgEl || !modalEl) {
    if (confirm(message)) callback();
    return;
  }
  msgEl.innerText = message;
  confirmCallback = callback;
  modalEl.classList.remove("hidden");
}

function handleConfirm(choice) {
  document.getElementById("confirm-modal").classList.add("hidden");
  if (choice && confirmCallback) confirmCallback();
  confirmCallback = null;
}

async function editItem(id) {
  if (!requireAuth("Please login to manage your listings.")) return;
  try {
    const res = await fetch(`${API_URL}/items/${id}/`);
    const item = await res.json();
    document.getElementById("title").value = item.title;
    document.getElementById("description").value = item.description;
    document.getElementById("price").value = item.price;
    document.getElementById("type").value = item.type;
    document.getElementById("category").value = item.category;
    document.getElementById("modal").classList.remove("hidden");
    document.getElementById("modal-title").innerText = "Edit Item";
    document.getElementById("post-btn-text").innerText = "Update Listing";
    editIndex = id;
  } catch (e) {
    alert("Could not fetch item details.");
  }
}

function getConversationSummaries() {
  const currentUserId = Number(localStorage.getItem("user_id"));
  const map = new Map();

  conversationSummaries.forEach((conversation) => {
    if (!conversation?.userId || Number(conversation.userId) === currentUserId)
      return;
    map.set(Number(conversation.userId), {
      userId: Number(conversation.userId),
      email: conversation.email,
      name: conversation.name || getEmailLabel(conversation.email),
      avatar: toAbsoluteMediaUrl(conversation.avatar || ""),
      isOnline: Boolean(conversation.isOnline),
      lastSeenAt: conversation.lastSeenAt || null,
      statusText: conversation.statusText || null,
      lastMessage: conversation.lastMessage || "Open chat",
      lastMessageStatus: conversation.lastMessageStatus || "",
      lastSenderId: conversation.lastSenderId ?? null,
      unreadCount: Number(conversation.unreadCount || 0),
      timestamp: conversation.timestamp || new Date(0).toISOString(),
    });
  });

  knownConversations.forEach((conversation) => {
    if (!conversation?.userId || Number(conversation.userId) === currentUserId)
      return;
    if (map.has(Number(conversation.userId))) return;
    map.set(Number(conversation.userId), {
      userId: Number(conversation.userId),
      email: conversation.email,
      name: conversation.name || getEmailLabel(conversation.email),
      avatar: toAbsoluteMediaUrl(conversation.avatar || ""),
      isOnline: conversation.status === "Online",
      lastSeenAt: null,
      statusText: conversation.status || "Offline",
      lastMessage: "Open chat",
      lastMessageStatus: "",
      lastSenderId: null,
      unreadCount: 0,
      timestamp: conversation.timestamp || new Date(0).toISOString(),
    });
  });

  allMessages.forEach((message) => {
    const partnerId =
      message.sender === currentUserId ? message.receiver : message.sender;
    const partnerEmail =
      message.sender === currentUserId
        ? message.receiver_email
        : message.sender_email;
    const partnerName =
      message.sender === currentUserId
        ? message.receiver_display_name
        : message.sender_display_name;
    const partnerAvatar =
      message.sender === currentUserId
        ? message.receiver_profile_picture_url
        : message.sender_profile_picture_url;
    const partnerIsOnline =
      message.sender === currentUserId
        ? message.receiver_is_online
        : message.sender_is_online;
    const partnerLastSeen =
      message.sender === currentUserId
        ? message.receiver_last_seen_at
        : message.sender_last_seen_at;
    const existing = map.get(partnerId);
    if (
      !existing ||
      new Date(message.timestamp) > new Date(existing.timestamp)
    ) {
      map.set(partnerId, {
        userId: partnerId,
        email: partnerEmail,
        name: getUserLabel(partnerName, partnerEmail),
        avatar: toAbsoluteMediaUrl(partnerAvatar),
        isOnline: Boolean(partnerIsOnline),
        lastSeenAt: partnerLastSeen,
        statusText: null,
        lastMessage: message.display_content || message.content,
        lastMessageStatus:
          message.status ||
          (message.seen_at
            ? "seen"
            : message.delivered_at
              ? "delivered"
              : "sent"),
        lastSenderId: message.sender,
        unreadCount: 0,
        timestamp: message.timestamp,
      });
    }

    if (
      message.receiver === currentUserId &&
      !message.seen_at &&
      Number(message.sender) === Number(partnerId)
    ) {
      const summary = map.get(partnerId);
      if (summary) summary.unreadCount += 1;
    }
  });

  if (
    currentChatUserId &&
    !map.has(currentChatUserId) &&
    currentChatUserEmail
  ) {
    map.set(currentChatUserId, {
      userId: currentChatUserId,
      email: currentChatUserEmail,
      name: currentChatUserName || getEmailLabel(currentChatUserEmail),
      avatar: toAbsoluteMediaUrl(currentChatUserAvatar),
      isOnline: currentChatUserStatus === "Online",
      lastSeenAt: null,
      statusText: currentChatUserStatus || "Offline",
      lastMessage: "Start a conversation",
      lastMessageStatus: "",
      lastSenderId: null,
      unreadCount: 0,
      timestamp: new Date(0).toISOString(),
    });
  }

  return Array.from(map.values())
    .filter((conversation) => {
      if (!conversationSearchQuery) return true;
      const haystack = normalizeSearchText(
        [
          conversation.name,
          conversation.email,
          conversation.lastMessage,
          conversation.statusText,
          conversation.isOnline ? "online" : "",
          getEmailLabel(conversation.email),
        ]
          .filter(Boolean)
          .join(" "),
      );
      return haystack.includes(conversationSearchQuery);
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function renderConversationList() {
  const container = document.getElementById("conversation-list");
  if (!container) return;

  const conversations = getConversationSummaries();
  const renderSignature = getConversationListRenderSignature(conversations);
  if (renderSignature === lastConversationListRenderSignature) return;

  if (conversations.length === 0) {
    container.innerHTML =
      '<div class="p-4 text-sm text-gray-500">No conversations yet.</div>';
    lastConversationListRenderSignature = renderSignature;
    renderChatButtonBadge();
    return;
  }

  container.innerHTML = conversations
    .map((conversation) => {
      const active = Number(currentChatUserId) === Number(conversation.userId);
      const initials = getInitials(conversation.name);
      const subtitle =
        conversation.statusText ||
        (conversation.isOnline
          ? "Online"
          : formatLastSeen(conversation.lastSeenAt));
      const statusMark =
        conversation.lastSenderId === Number(localStorage.getItem("user_id"))
          ? getMessageStatusLabel(
              { status: conversation.lastMessageStatus },
              true,
            )
          : "";
      return `
            <button type="button" onclick='selectConversation(${conversation.userId}, ${JSON.stringify(conversation.email)}, ${JSON.stringify(conversation.name || "")}, ${JSON.stringify(conversation.avatar || "")}, ${JSON.stringify(subtitle)})' class="w-full text-left px-4 py-4 border-b border-vloop-sage/50 transition ${active ? "bg-white border-l-4 border-vloop-dark" : "hover:bg-white/70 border-l-4 border-transparent"}">
                <div class="flex items-start gap-3">
                    <div class="relative shrink-0">
                        ${conversation.avatar ? `<img src="${conversation.avatar}" class="h-11 w-11 rounded-full object-cover border border-vloop-sage/40" alt="${escapeHtml(conversation.name)}">` : `<div class="h-11 w-11 rounded-full bg-vloop-dark text-white flex items-center justify-center text-xs font-bold">${initials}</div>`}
                        ${conversation.isOnline ? '<span class="status-dot absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full bg-emerald-500"></span>' : ""}
                    </div>
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center justify-between gap-3">
                            <p class="font-semibold text-vloop-dark truncate">${escapeHtml(conversation.name)}</p>
                            <span class="text-[10px] text-gray-400 shrink-0">${formatConversationTime(conversation.timestamp)}</span>
                        </div>
                        <p class="text-[11px] text-gray-400 truncate mt-1">${escapeHtml(subtitle)}</p>
                        <div class="mt-1 flex items-center justify-between gap-3">
                            <p class="text-sm text-gray-500 truncate">${escapeHtml(conversation.lastMessage)}</p>
                            <div class="flex items-center gap-2 shrink-0">
                                ${statusMark ? `<span class="text-[10px] text-gray-400">${statusMark}</span>` : ""}
                                ${conversation.unreadCount ? `<span class="min-w-5 rounded-full bg-vloop-dark px-1.5 py-0.5 text-center text-[10px] font-bold text-white">${conversation.unreadCount}</span>` : ""}
                            </div>
                        </div>
                    </div>
                </div>
            </button>
        `;
    })
    .join("");
  lastConversationListRenderSignature = renderSignature;
  renderChatButtonBadge();
}

async function refreshActiveConversation() {
  if (!currentChatUserId) return;
  try {
    const res = await fetch(
      `${API_URL}/messages/history/${currentChatUserId}/`,
      { headers: getHeaders(false) },
    );
    if (!res.ok) throw new Error("Failed to fetch history");
    const messages = await res.json();
    const changed = mergeHistory(messages);
    if (changed) {
      renderConversationList();
      renderCurrentConversation();
    }
  } catch (error) {
    console.error(error);
  }
}

function mergeHistory(messages) {
  const previousSignature = getMessageStateSignature(
    getConversationMessages(currentChatUserId),
  );
  const ids = new Set(messages.map((message) => Number(message.id)));
  allMessages = allMessages.filter((message) => {
    const sameConversation =
      (message.sender === Number(localStorage.getItem("user_id")) &&
        message.receiver === Number(currentChatUserId)) ||
      (message.receiver === Number(localStorage.getItem("user_id")) &&
        message.sender === Number(currentChatUserId));
    return !sameConversation || ids.has(Number(message.id));
  });
  messages.forEach((message) => upsertMessage(message));
  return (
    previousSignature !==
    getMessageStateSignature(getConversationMessages(currentChatUserId))
  );
}

function getConversationMessages(partnerId) {
  const currentUserId = Number(localStorage.getItem("user_id"));
  return allMessages
    .filter(
      (message) =>
        (message.sender === currentUserId &&
          message.receiver === Number(partnerId)) ||
        (message.receiver === currentUserId &&
          message.sender === Number(partnerId)),
    )
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function shouldShowConversationLoadingState(messages, allConversationMessages) {
  return (
    !hasLoadedMessagesOnce &&
    messages.length === 0 &&
    allConversationMessages.length === 0
  );
}

function renderCurrentConversation() {
  const emptyState = document.getElementById("chat-empty-state");
  const thread = document.getElementById("chat-thread");
  const title = document.getElementById("chat-user-name");
  const container = document.getElementById("chat-messages");

  if (!emptyState || !thread || !title || !container) return;

  if (!currentChatUserId || !currentChatUserEmail) {
    const emptySignature = "no-active-conversation";
    if (lastConversationThreadRenderSignature === emptySignature) return;
    emptyState.classList.add("hidden");
    thread.classList.remove("hidden");
    setChatComposerEnabled(false);
    toggleMessageSearch(false);
    title.innerText = "Select a conversation";
    const statusEl = document.getElementById("chat-user-status");
    if (statusEl) statusEl.innerText = "Open a chat to see status";
    container.innerHTML = `
            <div class="h-full flex items-center justify-center text-center text-gray-500">
                <div>
                    <p class="font-semibold text-vloop-dark mb-2">No chat selected</p>
                    <p class="text-sm">Choose a conversation from the left to start messaging.</p>
                </div>
            </div>
        `;
    updateTypingIndicator("");
    lastConversationThreadRenderSignature = emptySignature;
    return;
  }

  const currentUserId = Number(localStorage.getItem("user_id"));
  const messages =
    getConversationMessages(currentChatUserId).filter(messageMatchesSearch);
  const allConversationMessages = getConversationMessages(currentChatUserId);
  const previousConversationId = container.dataset.conversationId || "";
  const shouldStickToBottom =
    previousConversationId !== String(currentChatUserId) ||
    isNearBottom(container);
  const previousScrollTop = container.scrollTop;
  const latestMessage =
    allConversationMessages[allConversationMessages.length - 1];
  if (latestMessage) {
    const partnerOnline =
      latestMessage.sender === currentUserId
        ? latestMessage.receiver_is_online
        : latestMessage.sender_is_online;
    const partnerLastSeen =
      latestMessage.sender === currentUserId
        ? latestMessage.receiver_last_seen_at
        : latestMessage.sender_last_seen_at;
    currentChatUserStatus = partnerOnline
      ? "Online"
      : formatLastSeen(partnerLastSeen);
  }
  const renderSignature = getCurrentConversationRenderSignature(
    messages,
    allConversationMessages,
  );
  if (renderSignature === lastConversationThreadRenderSignature) return;
  emptyState.classList.add("hidden");
  thread.classList.remove("hidden");
  setChatComposerEnabled(true);
  container.dataset.conversationId = String(currentChatUserId);
  title.innerText = currentChatUserName || getEmailLabel(currentChatUserEmail);
  const statusEl = document.getElementById("chat-user-status");
  if (statusEl) statusEl.innerText = currentChatUserStatus || "Offline";
  setAvatar(
    "chat-user-avatar-image",
    "chat-user-avatar-fallback",
    currentChatUserAvatar,
    currentChatUserName || currentChatUserEmail,
  );

  if (
    messages.length === 0 &&
    allConversationMessages.length > 0 &&
    messageSearchQuery
  ) {
    container.innerHTML = `
            <div class="h-full flex items-center justify-center text-center text-gray-500">
                <div>
                    <p class="font-semibold text-vloop-dark mb-2">No matching messages</p>
                    <p class="text-sm">Try a different search term in this chat.</p>
                </div>
            </div>
        `;
    lastConversationThreadRenderSignature = renderSignature;
    return;
  }

  if (shouldShowConversationLoadingState(messages, allConversationMessages)) {
    container.innerHTML = "";
    lastConversationThreadRenderSignature = renderSignature;
    return;
  }

  if (messages.length === 0) {
    container.innerHTML = `
            <div class="h-full flex items-center justify-center text-center text-gray-500">
                <div>
                    <p class="font-semibold text-vloop-dark mb-2">Start the conversation</p>
                    <p class="text-sm">Your messages with ${escapeHtml(currentChatUserName || getEmailLabel(currentChatUserEmail))} will appear here.</p>
                </div>
            </div>
        `;
    lastConversationThreadRenderSignature = renderSignature;
    return;
  }

  container.innerHTML = messages
    .map((message) =>
      renderMessageCard(message, Number(message.sender) === currentUserId),
    )
    .join("");
  attachMessageActionListeners();
  if (shouldStickToBottom) {
    scrollMessagesToBottom();
  } else {
    container.scrollTop = previousScrollTop;
  }
  lastConversationThreadRenderSignature = renderSignature;
}

function renderMessageCard(message, isMe) {
  const text = message.display_content || message.content;
  const deleted = Boolean(message.deleted_for_everyone);
  const menuOpen = openMessageMenuId === Number(message.id);
  const replyBlock = message.reply_preview
    ? `
        <div class="mb-3 rounded-2xl border ${isMe ? "border-white/15 bg-white/10" : "border-vloop-sage/35 bg-vloop-cream/50"} px-3 py-2">
            <p class="text-[10px] uppercase tracking-[0.2em] ${isMe ? "text-white/70" : "text-vloop-base"}">${escapeHtml(message.reply_preview.sender_display_name)}</p>
            <p class="mt-1 truncate text-xs ${isMe ? "text-white/80" : "text-gray-500"}">${escapeHtml(message.reply_preview.content || message.reply_preview.attachment_name || "Attachment")}</p>
        </div>
    `
    : "";
  const forwardBlock = message.forwarded_preview
    ? `<p class="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] ${isMe ? "text-white/70" : "text-vloop-base"}">Forwarded</p>`
    : "";
  const attachmentBlock = message.attachment_url
    ? `
        <div class="mt-3">
            ${message.attachment_is_image ? `<img src="${message.attachment_url}" alt="${escapeHtml(message.attachment_name || "Attachment")}" class="max-h-60 rounded-2xl border border-vloop-sage/20 object-cover">` : `<a href="${message.attachment_url}" target="_blank" class="inline-flex items-center gap-2 rounded-2xl border ${isMe ? "border-white/20 bg-white/10 text-white" : "border-vloop-sage/40 bg-vloop-cream/60 text-vloop-dark"} px-3 py-2 text-sm font-semibold">${escapeHtml(message.attachment_name || "Attachment")}</a>`}
        </div>
    `
    : "";
  const statusLabel = getMessageStatusLabel(message, isMe);
  const menuLabelColor = isMe
    ? "text-white/80 hover:text-white"
    : "text-gray-400 hover:text-vloop-dark";
  const menuPanel = `
        <div class="relative">
            <button type="button" data-menu-button="true" onclick="toggleMessageMenu(${message.id})" class="rounded-full px-2 py-1 text-lg leading-none ${menuLabelColor}">⋯</button>
            <div data-message-menu="${message.id}" class="${menuOpen ? "" : "hidden"} absolute ${isMe ? "right-0" : "left-0"} top-9 z-20 min-w-[170px] rounded-2xl border border-vloop-sage/30 bg-white p-2 text-sm text-vloop-dark shadow-xl">
                <button type="button" data-action="reply" data-message-id="${message.id}" class="flex w-full rounded-xl px-3 py-2 text-left hover:bg-vloop-cream/70">Reply</button>
                <button type="button" data-action="forward" data-message-id="${message.id}" class="flex w-full rounded-xl px-3 py-2 text-left hover:bg-vloop-cream/70">Forward</button>
                <button type="button" data-action="delete-for-me" data-message-id="${message.id}" class="flex w-full rounded-xl px-3 py-2 text-left hover:bg-vloop-cream/70">Delete for me</button>
                ${isMe && !deleted ? `<button type="button" data-action="delete-for-everyone" data-message-id="${message.id}" class="flex w-full rounded-xl px-3 py-2 text-left hover:bg-vloop-cream/70">Delete for everyone</button>` : ""}
            </div>
        </div>
    `;
  return `
        <div class="message-card flex ${isMe ? "justify-end" : "justify-start"}" data-message-id="${message.id}">
            <div class="max-w-[82%]">
                <div class="${isMe ? "bg-vloop-dark text-white rounded-[22px] rounded-br-md" : "bg-white text-vloop-dark rounded-[22px] rounded-bl-md border border-vloop-sage/30"} px-4 py-3 shadow-sm">
                    ${forwardBlock}
                    ${replyBlock}
                    <p class="text-sm leading-6 ${deleted ? "italic opacity-75" : ""}">${escapeHtml(text)}</p>
                    ${attachmentBlock}
                    <div class="mt-2 flex items-center justify-between gap-3">
                        <span class="text-[10px] ${isMe ? "text-white/60" : "text-gray-400"}">${formatMessageTime(message.timestamp)}</span>
                        <div class="message-actions flex items-center gap-2 text-[10px] ${isMe ? "text-white/70" : "text-gray-500"}">
                            ${menuPanel}
                        </div>
                    </div>
                    ${statusLabel ? `<div class="mt-2 text-right text-[10px] ${isMe ? "text-white/60" : "text-gray-400"}">${statusLabel}</div>` : ""}
                </div>
            </div>
        </div>
    `;
}

function attachMessageActionListeners() {
  document.querySelectorAll("[data-menu-button='true']").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      toggleMessageMenu(
        Number(
          button.closest("[data-message-id]")?.dataset.messageId ||
            button.parentElement?.querySelector("[data-message-menu]")?.dataset
              .messageMenu,
        ),
      );
    };
  });
  document.querySelectorAll("[data-action='reply']").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      setReplyTarget(Number(button.dataset.messageId));
      openMessageMenuId = null;
      renderCurrentConversation();
    };
  });
  document.querySelectorAll("[data-action='forward']").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      openForwardModal(Number(button.dataset.messageId));
      openMessageMenuId = null;
    };
  });
  document
    .querySelectorAll("[data-action='delete-for-me']")
    .forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        openMessageMenuId = null;
        deleteMessageForMe(Number(button.dataset.messageId));
      };
    });
  document
    .querySelectorAll("[data-action='delete-for-everyone']")
    .forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        openMessageMenuId = null;
        deleteMessageForEveryone(Number(button.dataset.messageId));
      };
    });
}

function formatMessageTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function openChat(
  ownerId,
  ownerEmail,
  ownerName = "",
  ownerAvatar = "",
  ownerStatus = "",
) {
  if (!requireAuth("Please login to chat.")) return;

  upsertKnownConversation(
    ownerId,
    ownerEmail,
    ownerName,
    ownerAvatar,
    ownerStatus || "Offline",
  );
  toggleChatPanel(true);
  selectConversation(ownerId, ownerEmail, ownerName, ownerAvatar, ownerStatus);
}

async function selectConversation(
  userId,
  userEmail,
  userName = "",
  userAvatar = "",
  userStatus = "",
  connectSocket = true,
) {
  const previousChatUserId = Number(currentChatUserId);
  currentChatUserId = Number(userId);
  currentChatUserEmail = userEmail;
  currentChatUserName = userName || getEmailLabel(userEmail);
  currentChatUserAvatar = toAbsoluteMediaUrl(userAvatar);
  currentChatUserStatus = userStatus || currentChatUserStatus || "Offline";
  upsertKnownConversation(
    currentChatUserId,
    currentChatUserEmail,
    currentChatUserName,
    currentChatUserAvatar,
    currentChatUserStatus,
  );

  // Persist based on whether chat panel is actually visible
  const chatSection = document.getElementById("chat-section");
  const isChatOpen = Boolean(
    chatSection && !chatSection.classList.contains("pointer-events-none"),
  );
  persistChatUiState(isChatOpen);
  clearReplyTarget();
  if (previousChatUserId !== Number(currentChatUserId)) {
    lastConversationThreadRenderSignature = "";
  }
  renderConversationList();
  renderCurrentConversation();
  updateTypingIndicator("");

  if (connectSocket) {
    connectChatSocket(currentChatUserId);
    await refreshActiveConversation();
    focusChatInput();
  } else {
    renderCurrentConversation();
    focusChatInput();
  }
}

function connectChatSocket(receiverId) {
  const userId = localStorage.getItem("user_id");
  const token = localStorage.getItem("access_token");
  if (!userId || !receiverId || !token) return;

  const numericReceiverId = Number(receiverId);
  if (
    chatSocket &&
    chatSocketReceiverId === numericReceiverId &&
    (chatSocket.readyState === WebSocket.OPEN ||
      chatSocket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  if (chatSocket) {
    chatSocket.close();
  }

  chatSocketReceiverId = numericReceiverId;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";

  chatSocket = new WebSocket(
    `${protocol}://127.0.0.1:8000/ws/chat/${userId}/${receiverId}/?token=${encodeURIComponent(token)}`,
  );
  chatSocket.onmessage = (event) => handleSocketEvent(JSON.parse(event.data));
  chatSocket.onerror = () => null;
  chatSocket.onclose = () => {
    chatSocket = null;
    chatSocketReceiverId = null;
    updateTypingIndicator("");
  };
}

function handleSocketEvent(payload) {
  if (payload.type === "typing") {
    handleTypingEvent(payload);
    return;
  }

  if (payload.type === "message_deleted_for_me") {
    removeMessageLocally(payload.message_id);
    return;
  }

  if (payload.type === "message_deleted_for_everyone") {
    markMessageDeletedForEveryone(payload);
    return;
  }

  upsertMessage(normalizeMessage(payload));
  renderConversationList();
  renderCurrentConversation();
  maybeNotifyAboutMessage(payload);
}

function handleTypingEvent(payload) {
  if (Number(payload.sender_id) !== Number(currentChatUserId)) return;
  activeTypingUserId = payload.is_typing ? Number(payload.sender_id) : null;
  const label =
    payload.sender_display_name || getEmailLabel(payload.sender_email);
  updateTypingIndicator(payload.is_typing ? `${label} is typing...` : "");
}

function updateTypingIndicator(text) {
  const el = document.getElementById("typing-indicator");
  if (el) el.innerText = text || "";
}

function sendTypingState(isTyping) {
  if (
    !chatSocket ||
    chatSocket.readyState !== WebSocket.OPEN ||
    !currentChatUserId
  )
    return;
  chatSocket.send(
    JSON.stringify({
      type: "typing",
      sender_id: Number(localStorage.getItem("user_id")),
      receiver_id: currentChatUserId,
      is_typing: isTyping,
    }),
  );
}

async function buildForwardRequest(recipientId) {
  const baseContent =
    forwardingMessage?.display_content || forwardingMessage?.content || "";
  if (forwardingMessage?.attachment_url) {
    const attachmentResponse = await fetch(forwardingMessage.attachment_url);
    if (!attachmentResponse.ok) {
      throw new Error("Could not fetch attachment for forwarding.");
    }

    const attachmentBlob = await attachmentResponse.blob();
    const body = new FormData();
    body.append("receiver", String(recipientId));
    body.append("content", baseContent);
    body.append("forwarded_from_id", String(forwardingMessage.id));
    body.append(
      "attachment",
      attachmentBlob,
      forwardingMessage.attachment_name || "attachment",
    );
    return {
      headers: getHeaders(false),
      body,
    };
  }

  return {
    headers: getHeaders(),
    body: JSON.stringify({
      receiver: recipientId,
      content: baseContent,
      forwarded_from_id: forwardingMessage?.id || null,
    }),
  };
}

async function forwardMessageToRecipient(
  recipientId,
  recipientEmail,
  recipientName = "",
  recipientAvatar = "",
) {
  if (!forwardingMessage) return;

  try {
    const request = await buildForwardRequest(recipientId);
    const response = await fetch(`${API_URL}/messages/`, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      alert(getErrorMessage(data, "Could not forward the message."));
      return;
    }

    closeForwardModal();
    upsertMessage(data);
    renderConversationList();
    await selectConversation(
      recipientId,
      recipientEmail,
      recipientName,
      recipientAvatar,
    );
    showToast(
      `Forwarded to ${recipientName || getEmailLabel(recipientEmail)}.`,
    );
  } catch (error) {
    alert(error?.message || "Could not forward the message.");
  }
}

async function sendMessage(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const input = document.getElementById("chat-input");
  const msg = input.value.trim();

  if (!currentChatUserId || !currentChatUserEmail) {
    alert("Select a conversation first.");
    return;
  }

  if (!msg && !pendingChatAttachment && !forwardingMessage) return;

  // Keep chat open when actively exchanging messages.
  isChatOpenExplicitly = true;
  // Do not toggle UI again, only ensure state is persisted.
  persistChatUiState(true);

  if (
    !pendingChatAttachment &&
    !forwardingMessage &&
    chatSocket &&
    chatSocket.readyState === WebSocket.OPEN
  ) {
    chatSocket.send(
      JSON.stringify({
        type: "message",
        message: msg,
        sender_id: Number(localStorage.getItem("user_id")),
        receiver_id: currentChatUserId,
        reply_to_id: replyingToMessage?.id || null,
      }),
    );
    resetChatInput();
    sendTypingState(false);
    clearReplyTarget();
    return;
  }

  try {
    const hasFile = Boolean(pendingChatAttachment);
    const body = hasFile
      ? new FormData()
      : {
          receiver: currentChatUserId,
          content:
            msg ||
            forwardingMessage?.display_content ||
            forwardingMessage?.content ||
            "",
          reply_to_id: replyingToMessage?.id || null,
          forwarded_from_id: forwardingMessage?.id || null,
        };

    if (hasFile) {
      body.append("receiver", String(currentChatUserId));
      body.append("content", msg);
      body.append("attachment", pendingChatAttachment);
      if (replyingToMessage?.id)
        body.append("reply_to_id", String(replyingToMessage.id));
      if (forwardingMessage?.id)
        body.append("forwarded_from_id", String(forwardingMessage.id));
    }

    const response = await fetch(`${API_URL}/messages/`, {
      method: "POST",
      headers: hasFile ? getHeaders(false) : getHeaders(),
      body: hasFile ? body : JSON.stringify(body),
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      alert(getErrorMessage(data, "Could not send the message."));
      return;
    }

    upsertMessage(data);
    renderConversationList();
    renderCurrentConversation();
    scrollMessagesToBottom();
    resetChatInput();
    clearReplyTarget();
    clearForwardTarget();
    clearChatAttachment();
    connectChatSocket(currentChatUserId);
  } catch (error) {
    alert(SERVER_OFFLINE_MESSAGE);
  }
}

function normalizeMessage(data) {
  return {
    id: Number(data.id),
    sender: Number(data.sender_id ?? data.sender),
    receiver: Number(data.receiver_id ?? data.receiver),
    sender_email: data.sender_email,
    sender_display_name:
      data.sender_display_name || getEmailLabel(data.sender_email),
    sender_profile_picture_url: toAbsoluteMediaUrl(
      data.sender_profile_picture_url || "",
    ),
    sender_is_online: Boolean(data.sender_is_online),
    sender_last_seen_at: data.sender_last_seen_at || null,
    receiver_email: data.receiver_email,
    receiver_display_name:
      data.receiver_display_name || getEmailLabel(data.receiver_email),
    receiver_profile_picture_url: toAbsoluteMediaUrl(
      data.receiver_profile_picture_url || "",
    ),
    receiver_is_online: Boolean(data.receiver_is_online),
    receiver_last_seen_at: data.receiver_last_seen_at || null,
    content: data.content ?? data.message,
    display_content: data.display_content ?? data.message ?? data.content,
    attachment_url: toAbsoluteMediaUrl(data.attachment_url || ""),
    attachment_name: data.attachment_name || "",
    attachment_is_image: Boolean(data.attachment_is_image),
    reply_to_id: data.reply_to_id ? Number(data.reply_to_id) : null,
    reply_preview: data.reply_preview || null,
    forwarded_from_id: data.forwarded_from_id
      ? Number(data.forwarded_from_id)
      : null,
    forwarded_preview: data.forwarded_preview || null,
    status:
      data.status ||
      (data.seen_at ? "seen" : data.delivered_at ? "delivered" : "sent"),
    delivered_at: data.delivered_at ?? null,
    seen_at: data.seen_at ?? null,
    deleted_for_everyone: Boolean(data.deleted_for_everyone),
    deleted_at: data.deleted_at ?? null,
    can_delete_for_everyone: Boolean(data.can_delete_for_everyone),
    timestamp: data.timestamp,
  };
}

function upsertMessage(message) {
  const normalized = normalizeMessage(message);
  const index = allMessages.findIndex(
    (entry) => Number(entry.id) === normalized.id,
  );
  if (index >= 0) {
    const existing = allMessages[index];
    const merged = { ...existing, ...normalized };
    const changed =
      getMessageStateSignature([existing]) !==
      getMessageStateSignature([merged]);
    allMessages[index] = merged;
    return changed;
  }
  allMessages.push(normalized);
  return true;
}

function removeMessageLocally(messageId) {
  allMessages = allMessages.filter(
    (message) => Number(message.id) !== Number(messageId),
  );
  renderConversationList();
  renderCurrentConversation();
}

function markMessageDeletedForEveryone(payload) {
  upsertMessage(payload);
  renderConversationList();
  renderCurrentConversation();
}

async function deleteMessageForMe(messageId) {
  const res = await fetch(`${API_URL}/messages/${messageId}/delete-for-me/`, {
    method: "POST",
    headers: getHeaders(),
  });
  if (!res.ok) {
    alert("Could not delete the message for you.");
    return;
  }

  removeMessageLocally(messageId);

  if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
    chatSocket.send(
      JSON.stringify({
        type: "delete_for_me",
        message_id: messageId,
        sender_id: Number(localStorage.getItem("user_id")),
        receiver_id: currentChatUserId,
      }),
    );
  }
}

async function deleteMessageForEveryone(messageId) {
  const res = await fetch(
    `${API_URL}/messages/${messageId}/delete-for-everyone/`,
    {
      method: "POST",
      headers: getHeaders(),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || "Could not delete the message for everyone.");
    return;
  }

  markMessageDeletedForEveryone(normalizeMessage(data.message));

  if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
    chatSocket.send(
      JSON.stringify({
        type: "delete_for_everyone",
        message_id: messageId,
        sender_id: Number(localStorage.getItem("user_id")),
        receiver_id: currentChatUserId,
      }),
    );
  }
}

function maybeNotifyAboutMessage(payload) {
  const incoming = normalizeMessage(payload);
  const currentUserId = Number(localStorage.getItem("user_id"));
  if (incoming.sender === currentUserId) return;
  if (hasNotifiedMessage(incoming.id)) return;

  const chatHidden = document
    .getElementById("chat-section")
    ?.classList.contains("pointer-events-none");
  const otherConversation =
    Number(currentChatUserId) !== Number(incoming.sender);
  const pageHidden = document.hidden;
  if (!otherConversation && !pageHidden && !chatHidden) return;

  const sender =
    incoming.sender_display_name || incoming.sender_email || "New message";
  const messagePreview =
    incoming.display_content ||
    incoming.attachment_name ||
    "Sent an attachment";
  rememberNotifiedMessage(incoming.id);
  showToast(`${sender}: ${messagePreview}`);

  if ("Notification" in window && Notification.permission === "granted") {
    const notification = new Notification(sender, {
      body: messagePreview,
      tag: incoming.id ? `vloop-message-${incoming.id}` : undefined,
    });
    notification.onclick = () => {
      window.focus();
      toggleChatPanel(true);
      selectConversation(
        incoming.sender,
        incoming.sender_email,
        incoming.sender_display_name || "",
        incoming.sender_profile_picture_url || "",
        incoming.sender_is_online
          ? "Online"
          : formatLastSeen(incoming.sender_last_seen_at),
      );
      notification.close();
    };
  }
}

function showToast(text) {
  const toast = document.getElementById("chat-toast");
  const toastText = document.getElementById("chat-toast-text");
  if (!toast || !toastText) return;
  toastText.innerText = text;
  toast.classList.remove("hidden");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.add("hidden"), 3500);
}

function scrollMessagesToBottom() {
  const container = document.getElementById("chat-messages");
  if (container) container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

if (document.getElementById("items")) {
  pendingChatUiRestore = hasActiveSession() ? loadPersistedChatUiState() : null;
  if (pendingChatUiRestore?.userId && pendingChatUiRestore?.email) {
    primeChatUiFromPersistedState();
  }
  updateMarketplaceAccessState();
  renderChatButtonBadge();
  renderConversationList();
  renderCurrentConversation();
  loadItems();
  if (hasActiveSession()) {
    loadProfile();
    loadMessages().then(() => {
      if (pendingChatUiRestore?.isOpen) {
        restorePersistedChatUiState();
      }
    });
    messagePollingHandle = window.setInterval(() => {
      loadMessages();
    }, 5000);
  }
}

window.resetSecurityQuestionState = resetSecurityQuestionState;
