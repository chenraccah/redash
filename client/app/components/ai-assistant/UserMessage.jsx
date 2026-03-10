import React from "react";
import PropTypes from "prop-types";

function hasHebrew(text) {
  return /[\u0590-\u05FF]/.test(text);
}

export default function UserMessage({ content }) {
  return (
    <div className="ai-message ai-message--user">
      <div className="ai-message__avatar ai-message__avatar--user">
        <i className="fa fa-user" />
      </div>
      <div className="ai-message__bubble ai-message__bubble--user" dir={hasHebrew(content) ? "rtl" : "ltr"}>{content}</div>
    </div>
  );
}

UserMessage.propTypes = {
  content: PropTypes.string.isRequired,
};
