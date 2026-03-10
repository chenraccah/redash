import React from "react";
import PropTypes from "prop-types";

export default function UserMessage({ content }) {
  return (
    <div className="ai-message ai-message--user">
      <div className="ai-message__avatar ai-message__avatar--user">
        <i className="fa fa-user" />
      </div>
      <div className="ai-message__bubble ai-message__bubble--user" dir="auto">{content}</div>
    </div>
  );
}

UserMessage.propTypes = {
  content: PropTypes.string.isRequired,
};
