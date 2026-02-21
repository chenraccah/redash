import React, { useState, useEffect, useRef, useCallback } from "react";
import Select from "antd/lib/select";
import Button from "antd/lib/button";
import Input from "antd/lib/input";
import Modal from "antd/lib/modal";
import Link from "@/components/Link";
import routeWithUserSession from "@/components/ApplicationArea/routeWithUserSession";
import routes from "@/services/routes";
import notification from "@/services/notification";
import DataSource from "@/services/data-source";
import { Query } from "@/services/query";
import Visualization from "@/services/visualization";
import QueryResult from "@/services/query-result";
import AIAssistant from "@/services/ai-assistant";
import { Dashboard } from "@/services/dashboard";
import UserMessage from "@/components/ai-assistant/UserMessage";
import AssistantMessage from "@/components/ai-assistant/AssistantMessage";
import ChatHistorySidebar from "@/components/ai-assistant/ChatHistorySidebar";

import "./QueryAI.less";

const { TextArea } = Input;
const { Option } = Select;

function QueryAIPage() {
  const [dataSources, setDataSources] = useState([]);
  const [selectedDataSourceIds, setSelectedDataSourceIds] = useState([]);
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [queryResults, setQueryResults] = useState({});
  const [executingMessages, setExecutingMessages] = useState({});
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [conversations, setConversations] = useState([]);

  // Dashboard modal state
  const [showDashboardModal, setShowDashboardModal] = useState(false);
  const [pendingSaveData, setPendingSaveData] = useState(null);
  const [dashboardList, setDashboardList] = useState([]);
  const [selectedDashboardId, setSelectedDashboardId] = useState(null);
  const [newDashboardName, setNewDashboardName] = useState("");
  const [dashboardSaving, setDashboardSaving] = useState(false);

  const messagesEndRef = useRef(null);
  const chatContainerRef = useRef(null);

  // Load conversations list
  useEffect(() => {
    AIAssistant.getConversations()
      .then((result) => setConversations(result || []))
      .catch(() => {});
  }, []);

  const refreshConversations = useCallback(() => {
    AIAssistant.getConversations()
      .then((result) => setConversations(result || []))
      .catch(() => {});
  }, []);

  // Load data sources
  useEffect(() => {
    DataSource.query().then((result) => {
      const sources = result || [];
      setDataSources(sources);
      if (sources.length > 0) {
        // Try to restore last selected
        try {
          const lastIds = localStorage.getItem("lastSelectedDataSourceIds");
          if (lastIds) {
            const parsed = JSON.parse(lastIds);
            const valid = parsed.filter((id) => sources.find((ds) => ds.id === id));
            if (valid.length > 0) {
              setSelectedDataSourceIds(valid);
              return;
            }
          }
        } catch {
          // ignore
        }
        setSelectedDataSourceIds([sources[0].id]);
      }
    });
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, executingMessages]);

  const resolveDataSourceId = useCallback(
    (targetName) => {
      if (targetName) {
        const match = dataSources.find(
          (ds) => ds.name.toLowerCase() === targetName.toLowerCase()
        );
        if (match) return match.id;
      }
      return selectedDataSourceIds[0] || null;
    },
    [dataSources, selectedDataSourceIds]
  );

  const executeSQL = useCallback(
    (sql, messageIndex, targetDataSourceName) => {
      const dsId = resolveDataSourceId(targetDataSourceName);
      if (!dsId || !sql) return;

      setExecutingMessages((prev) => ({ ...prev, [messageIndex]: true }));

      const queryResult = QueryResult.get(
        dsId,
        sql,
        {},
        false,
        -1,
        null
      );

      queryResult
        .toPromise()
        .then((result) => {
          setQueryResults((prev) => ({ ...prev, [messageIndex]: result }));
          setExecutingMessages((prev) => ({ ...prev, [messageIndex]: false }));
        })
        .catch((error) => {
          setExecutingMessages((prev) => ({ ...prev, [messageIndex]: false }));

          const errorMessage = error.getError ? error.getError() : String(error);

          // Auto-send error back to LLM for correction
          if (conversation) {
            AIAssistant.sendMessage(conversation.id, {
              message: "The query returned an error. Please fix it.",
              data_source_ids: selectedDataSourceIds,
              error_context: errorMessage,
            })
              .then((result) => {
                const conv = result.conversation;
                setConversation(conv);
                setMessages(conv.messages);
                // Auto-execute the corrected query
                const lastMsg = conv.messages[conv.messages.length - 1];
                if (lastMsg && lastMsg.sql) {
                  executeSQL(lastMsg.sql, conv.messages.length - 1, lastMsg.target_data_source);
                }
              })
              .catch(() => {
                notification.error("Failed to get error correction from AI.");
              });
          }
        });
    },
    [resolveDataSourceId, selectedDataSourceIds, conversation]
  );

  // Core send logic — used by both input bar and quick actions
  const doSend = useCallback(
    async (text) => {
      if (!text || isSending) return;

      if (selectedDataSourceIds.length === 0) {
        notification.warning("Please select at least one data source.");
        return;
      }

      setIsSending(true);

      // Show user message immediately before AI responds
      setMessages((prev) => [
        ...prev,
        { role: "user", content: text, timestamp: new Date().toISOString() },
      ]);

      try {
        let conv = conversation;

        // Create conversation if needed
        if (!conv) {
          conv = await AIAssistant.createConversation({
            data_source_ids: selectedDataSourceIds,
            data_source_id: selectedDataSourceIds[0],
          });
          setConversation(conv);
        }

        // Send the message
        const result = await AIAssistant.sendMessage(conv.id, {
          message: text,
          data_source_ids: selectedDataSourceIds,
        });

        const updatedConv = result.conversation;
        setConversation(updatedConv);
        // Replace optimistic messages with full conversation from server
        setMessages(updatedConv.messages);
        refreshConversations();

        // Auto-execute SQL if present in the response
        const lastMsg = updatedConv.messages[updatedConv.messages.length - 1];
        if (lastMsg && lastMsg.sql) {
          executeSQL(lastMsg.sql, updatedConv.messages.length - 1, lastMsg.target_data_source);
        }
      } catch (err) {
        const errorMsg =
          err.response?.data?.message || err.message || "Unknown error";
        notification.error("AI Assistant error: " + errorMsg);
      } finally {
        setIsSending(false);
      }
    },
    [isSending, selectedDataSourceIds, conversation, executeSQL, refreshConversations]
  );

  const sendMessage = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;
    setInputValue("");
    doSend(text);
  }, [inputValue, doSend]);

  const handleQuickAction = useCallback(
    (text) => {
      doSend(text);
    },
    [doSend]
  );

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  const handleEditAndRun = useCallback(
    (sql, vizConfig, messageIndex, targetDataSource) => {
      executeSQL(sql, messageIndex, targetDataSource);
    },
    [executeSQL]
  );

  const handleSaveQuery = useCallback(
    async (sql, vizConfig, targetDataSourceName) => {
      const dsId = resolveDataSourceId(targetDataSourceName);
      if (!dsId || !sql) return;

      try {
        const queryData = {
          name: conversation ? conversation.title : "AI Generated Query",
          query: sql,
          data_source_id: dsId,
          is_draft: false,
          options: {},
        };

        const savedQuery = await Query.save(queryData);

        // Create visualization if suggested
        if (vizConfig && vizConfig.type && vizConfig.type !== "TABLE") {
          await Visualization.save({
            query_id: savedQuery.id,
            type: vizConfig.type,
            name: vizConfig.name || "AI Generated",
            options: vizConfig.options || {},
          });
        }

        notification.success(
          <span>
            Query saved!{" "}
            <Link href={`queries/${savedQuery.id}`}>View query</Link>
          </span>
        );
      } catch (err) {
        notification.error("Failed to save query: " + (err.message || "Unknown error"));
      }
    },
    [resolveDataSourceId, conversation]
  );

  // Dashboard flow: open modal
  const handleSaveToDashboard = useCallback(
    (sql, vizConfig, targetDataSourceName) => {
      setPendingSaveData({ sql, vizConfig, targetDataSourceName });
      setSelectedDashboardId(null);
      setNewDashboardName("");

      // Fetch user's dashboards
      Dashboard.query({ page_size: 250 })
        .then((response) => {
          setDashboardList(response.results || []);
          setShowDashboardModal(true);
        })
        .catch(() => {
          // If fetch fails, still show modal with "create new" option
          setDashboardList([]);
          setShowDashboardModal(true);
        });
    },
    []
  );

  // Dashboard flow: confirm save + add widget
  const confirmDashboardSave = useCallback(async () => {
    if (!pendingSaveData) return;
    if (!selectedDashboardId) {
      notification.warning("Please select a dashboard or create a new one.");
      return;
    }

    const { sql, vizConfig, targetDataSourceName } = pendingSaveData;
    const dsId = resolveDataSourceId(targetDataSourceName);
    if (!dsId || !sql) return;

    setDashboardSaving(true);

    try {
      // 1. Save the query
      const savedQuery = await Query.save({
        name: conversation ? conversation.title : "AI Generated Query",
        query: sql,
        data_source_id: dsId,
        is_draft: false,
        options: {},
      });

      // 2. Create or use default visualization
      let vizForDashboard;
      if (vizConfig && vizConfig.type && vizConfig.type !== "TABLE") {
        vizForDashboard = await Visualization.save({
          query_id: savedQuery.id,
          type: vizConfig.type,
          name: vizConfig.name || "AI Generated",
          options: vizConfig.options || {},
        });
      } else {
        // Use the auto-created TABLE visualization
        vizForDashboard =
          savedQuery.visualizations && savedQuery.visualizations[0];
      }

      if (!vizForDashboard || !vizForDashboard.id) {
        notification.error("Could not create visualization.");
        return;
      }

      // 3. Get or create the dashboard
      let dashboard;
      if (selectedDashboardId === "new") {
        dashboard = await Dashboard.save({
          name: newDashboardName || "AI Dashboard",
        });
      } else {
        dashboard = await Dashboard.get({ id: selectedDashboardId });
      }

      // 4. Add the widget
      await dashboard.addWidget(vizForDashboard);

      const dashUrl = dashboard.url || `dashboards/${dashboard.id}`;
      notification.success(
        <span>
          Added to dashboard!{" "}
          <Link href={dashUrl}>View dashboard</Link>
        </span>
      );

      setShowDashboardModal(false);
      setPendingSaveData(null);
    } catch (err) {
      notification.error(
        "Failed to add to dashboard: " + (err.message || "Unknown error")
      );
    } finally {
      setDashboardSaving(false);
    }
  }, [
    pendingSaveData,
    selectedDashboardId,
    newDashboardName,
    resolveDataSourceId,
    conversation,
  ]);

  const handleNewConversation = useCallback(() => {
    setConversation(null);
    setMessages([]);
    setQueryResults({});
    setExecutingMessages({});
    setInputValue("");
  }, []);

  const handleSelectConversation = useCallback(
    (id) => {
      AIAssistant.getConversation(id)
        .then((conv) => {
          setConversation(conv);
          setMessages(conv.messages || []);
          setQueryResults({});
          setExecutingMessages({});

          // Determine data source IDs from conversation
          const dsIds = conv.data_source_ids && conv.data_source_ids.length > 0
            ? conv.data_source_ids
            : conv.data_source_id
              ? [conv.data_source_id]
              : selectedDataSourceIds;
          setSelectedDataSourceIds(dsIds);

          // Re-execute all SQL queries to restore visualizations
          const fallbackDsId = dsIds[0];
          (conv.messages || []).forEach((msg, idx) => {
            if (msg.role === "assistant" && msg.sql) {
              let dsId = fallbackDsId;
              if (msg.target_data_source) {
                const match = dataSources.find(
                  (ds) => ds.name.toLowerCase() === msg.target_data_source.toLowerCase()
                );
                if (match) dsId = match.id;
              }
              if (dsId) {
                setExecutingMessages((prev) => ({ ...prev, [idx]: true }));
                const qr = QueryResult.get(dsId, msg.sql, {}, false, -1, null);
                qr.toPromise()
                  .then((result) => {
                    setQueryResults((prev) => ({ ...prev, [idx]: result }));
                    setExecutingMessages((prev) => ({ ...prev, [idx]: false }));
                  })
                  .catch(() => {
                    setExecutingMessages((prev) => ({ ...prev, [idx]: false }));
                  });
              }
            }
          });
        })
        .catch(() => {
          notification.error("Failed to load conversation.");
        });
    },
    [dataSources, selectedDataSourceIds]
  );

  const handleArchiveConversation = useCallback(
    (id) => {
      AIAssistant.archiveConversation(id)
        .then(() => {
          setConversations((prev) => prev.filter((c) => c.id !== id));
          if (conversation && conversation.id === id) {
            handleNewConversation();
          }
        })
        .catch(() => {
          notification.error("Failed to archive conversation.");
        });
    },
    [conversation, handleNewConversation]
  );

  const handleDataSourceChange = useCallback(
    (dsIds) => {
      setSelectedDataSourceIds(dsIds);
      try {
        localStorage.setItem("lastSelectedDataSourceIds", JSON.stringify(dsIds));
      } catch {
        // ignore
      }
      // Reset conversation when data source changes
      handleNewConversation();
    },
    [handleNewConversation]
  );

  return (
    <div className="query-ai-page">
      <ChatHistorySidebar
        conversations={conversations}
        activeConversationId={conversation ? conversation.id : null}
        onSelect={handleSelectConversation}
        onArchive={handleArchiveConversation}
        onNewChat={handleNewConversation}
      />
      <div className="query-ai-main">
        {/* Header */}
        <div className="query-ai-header">
          <div className="query-ai-header__left">
            <h3>AI Query Builder</h3>
          </div>
          <div className="query-ai-header__right">
            <Select
              className="query-ai-ds-select"
              mode="multiple"
              placeholder="Select Data Sources"
              value={selectedDataSourceIds}
              onChange={handleDataSourceChange}
              showSearch
              optionFilterProp="children"
              maxTagCount={2}
              maxTagPlaceholder={(omitted) => `+${omitted.length} more`}>
              {dataSources.map((ds) => (
                <Option key={ds.id} value={ds.id}>
                  {ds.name}
                </Option>
              ))}
            </Select>
          </div>
        </div>

        {/* Chat area */}
        <div className="query-ai-chat" ref={chatContainerRef}>
          {messages.length === 0 && (
            <div className="query-ai-empty">
              <div className="query-ai-empty__icon">
                <i className="fa fa-magic" />
              </div>
              <h2>What do you want to explore?</h2>
              <p>
                Describe the data you want to see in plain language. I'll write the SQL query and
                pick the best visualization for you.
              </p>
              <div className="query-ai-empty__examples">
                <Button
                  className="query-ai-example-btn"
                  onClick={() => setInputValue("Show me total sales by month for the past year")}>
                  Total sales by month
                </Button>
                <Button
                  className="query-ai-example-btn"
                  onClick={() => setInputValue("What are the top 10 customers by revenue?")}>
                  Top 10 customers
                </Button>
                <Button
                  className="query-ai-example-btn"
                  onClick={() =>
                    setInputValue("Show me the distribution of orders by status as a pie chart")
                  }>
                  Orders by status
                </Button>
              </div>
            </div>
          )}

          {messages.map((msg, idx) =>
            msg.role === "user" ? (
              <UserMessage key={idx} content={msg.content} />
            ) : (
              <AssistantMessage
                key={idx}
                message={msg}
                queryResult={queryResults[idx]}
                isExecuting={!!executingMessages[idx]}
                onEditAndRun={(sql, vizConfig) => handleEditAndRun(sql, vizConfig, idx, msg.target_data_source)}
                onSaveQuery={(sql, vizConfig) => handleSaveQuery(sql, vizConfig, msg.target_data_source)}
                onSaveToDashboard={(sql, vizConfig) => handleSaveToDashboard(sql, vizConfig, msg.target_data_source)}
                onQuickAction={handleQuickAction}
              />
            )
          )}

          {isSending && (
            <div className="ai-message ai-message--loading">
              <div className="ai-message__avatar ai-message__avatar--assistant">
                <i className="fa fa-magic" />
              </div>
              <div className="ai-message__bubble ai-message__bubble--assistant">
                <div className="ai-typing-dots">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input bar */}
        <div className="query-ai-input">
          <TextArea
            placeholder={
              selectedDataSourceIds.length > 0
                ? "Describe what data you want to see..."
                : "Select a data source first..."
            }
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            autoSize={{ minRows: 1, maxRows: 4 }}
            disabled={isSending || selectedDataSourceIds.length === 0}
          />
          <Button
            type="primary"
            disabled={!inputValue.trim() || isSending || selectedDataSourceIds.length === 0}
            onClick={sendMessage}
            loading={isSending}>
            <i className="fa fa-paper-plane" />
          </Button>
        </div>
      </div>

      {/* Dashboard picker modal */}
      <Modal
        title="Add to Dashboard"
        visible={showDashboardModal}
        onOk={confirmDashboardSave}
        onCancel={() => {
          setShowDashboardModal(false);
          setPendingSaveData(null);
        }}
        confirmLoading={dashboardSaving}
        okText="Add to Dashboard">
        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 6, fontWeight: 500 }}>Select a dashboard:</div>
          <Select
            style={{ width: "100%" }}
            placeholder="Choose a dashboard..."
            value={selectedDashboardId}
            onChange={(val) => setSelectedDashboardId(val)}
            showSearch
            optionFilterProp="children">
            <Option value="new">+ Create new dashboard</Option>
            {dashboardList.map((d) => (
              <Option key={d.id} value={d.id}>
                {d.name}
              </Option>
            ))}
          </Select>
        </div>
        {selectedDashboardId === "new" && (
          <div>
            <div style={{ marginBottom: 6, fontWeight: 500 }}>Dashboard name:</div>
            <Input
              placeholder="My Dashboard"
              value={newDashboardName}
              onChange={(e) => setNewDashboardName(e.target.value)}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}

routes.register(
  "Queries.AI",
  routeWithUserSession({
    path: "/queries/ai",
    title: "AI Query Builder",
    render: (pageProps) => <QueryAIPage {...pageProps} />,
    bodyClass: "fixed-layout",
  })
);

export default QueryAIPage;
