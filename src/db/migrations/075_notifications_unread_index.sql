-- The bell's unread count (polled every minute by both apps) reads only unread
-- rows: a partial index keeps it fast however large the notifications table grows.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id) WHERE is_read = false;
