const FORUM_TOPIC_EVENTS = [
  "forum_topic_created", "forum_topic_edited", "forum_topic_closed", "forum_topic_reopened"
];

// Check the outer message only: a pin or reply can contain ordinary user text.
const SERVICE_EVENTS = [
  ...FORUM_TOPIC_EVENTS,
  "pinned_message", "new_chat_members", "left_chat_member", "new_chat_title",
  "new_chat_photo", "delete_chat_photo", "group_chat_created", "supergroup_chat_created",
  "channel_chat_created", "message_auto_delete_timer_changed", "migrate_to_chat_id",
  "migrate_from_chat_id", "successful_payment", "refunded_payment", "users_shared",
  "chat_shared", "connected_website", "write_access_allowed", "passport_data",
  "proximity_alert_triggered", "boost_added", "chat_background_set",
  "general_forum_topic_hidden", "general_forum_topic_unhidden", "giveaway_created",
  "giveaway_completed", "video_chat_scheduled", "video_chat_started", "video_chat_ended",
  "video_chat_participants_invited", "web_app_data"
];

export function isForumTopicServiceMessage(message) {
  return Boolean(message && FORUM_TOPIC_EVENTS.some((field) => message[field] != null));
}

export function isTelegramServiceMessage(message) {
  return Boolean(message && SERVICE_EVENTS.some((field) => message[field] != null));
}
