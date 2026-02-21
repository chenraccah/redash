import React from "react";
import PropTypes from "prop-types";
import Button from "antd/lib/button";
import Tooltip from "@/components/Tooltip";

function formatDate(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  const now = new Date();
  const diff = now - d;
  const oneDay = 86400000;

  if (diff < oneDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diff < 7 * oneDay) {
    return d.toLocaleDateString([], { weekday: "short" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function ChatHistorySidebar({
  conversations,
  activeConversationId,
  onSelect,
  onArchive,
  onNewChat,
}) {
  return (
    <div className="chat-history-sidebar">
      <div className="chat-history-sidebar__header">
        <span className="chat-history-sidebar__title">Chat History</span>
        <Button size="small" type="primary" onClick={onNewChat}>
          <i className="fa fa-plus" /> New
        </Button>
      </div>
      <div className="chat-history-sidebar__list">
        {conversations.length === 0 && (
          <div className="chat-history-sidebar__empty">No conversations yet</div>
        )}
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`chat-history-item${conv.id === activeConversationId ? " chat-history-item--active" : ""}`}
            onClick={() => onSelect(conv.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onSelect(conv.id)}>
            <div className="chat-history-item__content">
              <div className="chat-history-item__title">{conv.title || "New Conversation"}</div>
              <div className="chat-history-item__date">{formatDate(conv.updated_at || conv.created_at)}</div>
            </div>
            <Tooltip title="Archive">
              <button
                className="chat-history-item__archive"
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive(conv.id);
                }}>
                <i className="fa fa-archive" />
              </button>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  );
}

ChatHistorySidebar.propTypes = {
  conversations: PropTypes.array,
  activeConversationId: PropTypes.number,
  onSelect: PropTypes.func.isRequired,
  onArchive: PropTypes.func.isRequired,
  onNewChat: PropTypes.func.isRequired,
};

ChatHistorySidebar.defaultProps = {
  conversations: [],
  activeConversationId: null,
};
