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

function getQuickActions(visualization) {
  if (!visualization) return [];
  const type = visualization.type;
  const seriesType = (visualization.options || {}).globalSeriesType;

  if (type === "CHART") {
    if (seriesType === "pie") {
      return ["Show as bar chart", "Show as table"];
    }
    return ["Show as pie chart", "Add date filter", "Show top 10 only"];
  }
  if (type === "COUNTER") {
    return ["Break down by category", "Show trend over time"];
  }
  if (type === "TABLE") {
    return ["Show as bar chart", "Summarize as counter"];
  }
  return [];
}

export default function AssistantMessage({
  message,
  queryResult,
  isExecuting,
  onEditAndRun,
  onSaveQuery,
  onSaveToDashboard,
  onQuickAction,
  dbType,
  schema,
}) {
  const [editedSql, setEditedSql] = useState(message.sql || "");
  const [copied, setCopied] = useState(false);
  const [vizHeight, setVizHeight] = useState(500);
  const textareaRef = useRef(null);

  const handleCopy = useCallback(
    (e) => {
      e.stopPropagation();
      try {
        const textarea = document.createElement("textarea");
        textarea.value = message.sql;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Copy failed
      }
    },
    [message.sql]
  );

  const handleResizeStart = useCallback(
    (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = vizHeight;

      const onMove = (moveEvent) => {
        const delta = moveEvent.clientY - startY;
        setVizHeight(Math.min(800, Math.max(150, startHeight + delta)));
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [vizHeight]
  );

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

  const handleSaveToDashboard = useCallback(() => {
    const sql = editedSql.trim() || message.sql;
    if (sql && onSaveToDashboard) {
      onSaveToDashboard(sql, message.visualization);
    }
  }, [editedSql, message.sql, message.visualization, onSaveToDashboard]);

  const vizObject = message.visualization
    ? {
        id: 0,
        type: message.visualization.type || "TABLE",
        name: message.visualization.name || "Result",
        options: message.visualization.options || {},
      }
    : { id: 0, type: "TABLE", name: "Result", options: {} };

  const quickActions =
    !isExecuting && queryResult && message.visualization
      ? getQuickActions(message.visualization)
      : [];

  const sqlPanelHeader = (
    <span className="ai-sql-header">
      <i className="fa fa-code ai-sql-header__icon" /> View SQL
      <Tooltip title={copied ? "Copied!" : "Copy SQL"}>
        <button
          className={`ai-copy-btn${copied ? " ai-copy-btn--copied" : ""}`}
          onClick={handleCopy}>
          <i className={copied ? "fa fa-check" : "fa fa-copy"} />
        </button>
      </Tooltip>
    </span>
  );

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

        {/* Target data source indicator */}
        {message.target_data_source && (
          <div className="ai-target-ds">
            <i className="fa fa-database" /> {message.target_data_source}
          </div>
        )}

        {/* Collapsible SQL peek with copy button */}
        {message.sql && (
          <Collapse ghost className="ai-sql-peek">
            <Panel header={sqlPanelHeader} key="sql">
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
          <>
            <div className="ai-viz-container" style={{ height: vizHeight }}>
              <VisualizationRenderer
                visualization={vizObject}
                queryResult={queryResult}
                context="query"
              />
            </div>
            <div className="ai-viz-resize-handle" onMouseDown={handleResizeStart}>
              <div className="ai-viz-resize-grip" />
            </div>
          </>
        )}

        {/* Action buttons */}
        {message.sql && queryResult && !isExecuting && (
          <div className="ai-message__actions">
            <Tooltip title="Save as a regular Redash query">
              <Button size="small" onClick={handleSave}>
                <i className="fa fa-save" /> Save Query
              </Button>
            </Tooltip>
            <Tooltip title="Save query and add to a dashboard">
              <Button size="small" onClick={handleSaveToDashboard}>
                <i className="fa fa-tachometer" /> Add to Dashboard
              </Button>
            </Tooltip>
          </div>
        )}

        {/* Quick action suggestions */}
        {quickActions.length > 0 && (
          <div className="ai-quick-actions">
            {quickActions.map((action) => (
              <button
                key={action}
                className="ai-quick-action"
                onClick={() => onQuickAction && onQuickAction(action)}>
                {action}
              </button>
            ))}
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
    target_data_source: PropTypes.string,
  }).isRequired,
  queryResult: PropTypes.object,
  isExecuting: PropTypes.bool,
  onEditAndRun: PropTypes.func,
  onSaveQuery: PropTypes.func,
  onSaveToDashboard: PropTypes.func,
  onQuickAction: PropTypes.func,
  dbType: PropTypes.string,
  schema: PropTypes.array,
};

AssistantMessage.defaultProps = {
  queryResult: null,
  isExecuting: false,
  onEditAndRun: null,
  onSaveQuery: null,
  onSaveToDashboard: null,
  onQuickAction: null,
  dbType: "sql",
  schema: [],
};
