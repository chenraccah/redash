import React, { useState, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import Button from "antd/lib/button";
import Collapse from "antd/lib/collapse";
import Spin from "antd/lib/spin";
import Tooltip from "@/components/Tooltip";
import VisualizationRenderer from "@/components/visualizations/VisualizationRenderer";

const { Panel } = Collapse;

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(content) {
  // Strip visualization blocks — they're rendered separately
  let cleaned = content.replace(/```visualization[\s\S]*?```/g, "");
  // Strip SQL blocks — rendered separately in the collapsible
  cleaned = cleaned.replace(/```sql[\s\S]*?```/g, "");
  // Convert remaining code blocks
  cleaned = cleaned.replace(
    /```(\w*)\n?([\s\S]*?)```/g,
    (_, lang, code) => `<pre class="ai-code-block ${lang}">${escapeHtml(code.trim())}</pre>`
  );
  cleaned = cleaned.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Bold
  cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Line breaks
  cleaned = cleaned.replace(/\n/g, "<br />");
  return cleaned;
}

export default function AssistantMessage({
  message,
  queryResult,
  isExecuting,
  onEditAndRun,
  onSaveQuery,
  dbType,
  schema,
}) {
  const [editedSql, setEditedSql] = useState(message.sql || "");
  const textareaRef = useRef(null);

  const handleRunEdited = useCallback(() => {
    if (editedSql.trim() && onEditAndRun) {
      onEditAndRun(editedSql.trim(), message.visualization);
    }
  }, [editedSql, onEditAndRun, message.visualization]);

  const handleSave = useCallback(() => {
    const sql = editedSql.trim() || message.sql;
    if (sql && onSaveQuery) {
      onSaveQuery(sql, message.visualization);
    }
  }, [editedSql, message.sql, message.visualization, onSaveQuery]);

  const vizObject = message.visualization
    ? {
        id: 0,
        type: message.visualization.type || "TABLE",
        name: message.visualization.name || "Result",
        options: message.visualization.options || {},
      }
    : { id: 0, type: "TABLE", name: "Result", options: {} };

  return (
    <div className="ai-message ai-message--assistant">
      <div className="ai-message__avatar ai-message__avatar--assistant">
        <i className="fa fa-magic" />
      </div>
      <div className="ai-message__bubble ai-message__bubble--assistant">
        {/* Text explanation */}
        <div
          className="ai-message__text"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
        />

        {/* Collapsible SQL peek */}
        {message.sql && (
          <Collapse ghost className="ai-sql-peek">
            <Panel header="View SQL" key="sql">
              <textarea
                ref={textareaRef}
                className="ai-sql-editor"
                value={editedSql}
                onChange={(e) => setEditedSql(e.target.value)}
                spellCheck={false}
              />
              <div className="ai-sql-actions">
                <Button size="small" type="primary" onClick={handleRunEdited}>
                  <i className="zmdi zmdi-play" /> Run Edited Query
                </Button>
              </div>
            </Panel>
          </Collapse>
        )}

        {/* Inline visualization */}
        {isExecuting && (
          <div className="ai-viz-loading">
            <Spin size="default" /> Running query...
          </div>
        )}
        {queryResult && !isExecuting && (
          <div className="ai-viz-container">
            <VisualizationRenderer
              visualization={vizObject}
              queryResult={queryResult}
              context="query"
            />
          </div>
        )}

        {/* Action buttons */}
        {message.sql && queryResult && !isExecuting && (
          <div className="ai-message__actions">
            <Tooltip title="Save as a regular Redash query">
              <Button size="small" onClick={handleSave}>
                <i className="fa fa-save" /> Save Query
              </Button>
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  );
}

AssistantMessage.propTypes = {
  message: PropTypes.shape({
    content: PropTypes.string.isRequired,
    sql: PropTypes.string,
    visualization: PropTypes.object,
  }).isRequired,
  queryResult: PropTypes.object,
  isExecuting: PropTypes.bool,
  onEditAndRun: PropTypes.func,
  onSaveQuery: PropTypes.func,
  dbType: PropTypes.string,
  schema: PropTypes.array,
};

AssistantMessage.defaultProps = {
  queryResult: null,
  isExecuting: false,
  onEditAndRun: null,
  onSaveQuery: null,
  dbType: "sql",
  schema: [],
};
