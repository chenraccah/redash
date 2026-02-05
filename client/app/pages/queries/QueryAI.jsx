import React, { useState, useEffect, useRef, useCallback } from "react";
import Select from "antd/lib/select";
import Button from "antd/lib/button";
import Input from "antd/lib/input";
import Spin from "antd/lib/spin";
import Link from "@/components/Link";
import Tooltip from "@/components/Tooltip";
import routeWithUserSession from "@/components/ApplicationArea/routeWithUserSession";
import routes from "@/services/routes";
import notification from "@/services/notification";
import DataSource from "@/services/data-source";
import { Query } from "@/services/query";
import Visualization from "@/services/visualization";
import QueryResult from "@/services/query-result";
import AIAssistant from "@/services/ai-assistant";
import UserMessage from "@/components/ai-assistant/UserMessage";
import AssistantMessage from "@/components/ai-assistant/AssistantMessage";

import "./QueryAI.less";

const { TextArea } = Input;
const { Option } = Select;

function QueryAIPage() {
  const [dataSources, setDataSources] = useState([]);
  const [selectedDataSourceId, setSelectedDataSourceId] = useState(null);
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [queryResults, setQueryResults] = useState({});
  const [executingMessages, setExecutingMessages] = useState({});
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef(null);
  const chatContainerRef = useRef(null);

  // Load data sources
  useEffect(() => {
    DataSource.query().then((result) => {
      const sources = result || [];
      setDataSources(sources);
      if (sources.length > 0) {
        // Try to restore last selected
        try {
          const lastId = localStorage.getItem("lastSelectedDataSourceId");
          if (lastId && sources.find((ds) => ds.id === parseInt(lastId, 10))) {
            setSelectedDataSourceId(parseInt(lastId, 10));
          } else {
            setSelectedDataSourceId(sources[0].id);
          }
        } catch {
          setSelectedDataSourceId(sources[0].id);
        }
      }
    });
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, executingMessages]);

  const executeSQL = useCallback(
    (sql, messageIndex) => {
      if (!selectedDataSourceId || !sql) return;

      setExecutingMessages((prev) => ({ ...prev, [messageIndex]: true }));

      const queryResult = QueryResult.get(
        selectedDataSourceId,
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
              data_source_id: selectedDataSourceId,
              error_context: errorMessage,
            })
              .then((result) => {
                const conv = result.conversation;
                setConversation(conv);
                setMessages(conv.messages);
                // Auto-execute the corrected query
                const lastMsg = conv.messages[conv.messages.length - 1];
                if (lastMsg && lastMsg.sql) {
                  executeSQL(lastMsg.sql, conv.messages.length - 1);
                }
              })
              .catch(() => {
                notification.error("Failed to get error correction from AI.");
              });
          }
        });
    },
    [selectedDataSourceId, conversation]
  );

  const sendMessage = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isSending) return;

    if (!selectedDataSourceId) {
      notification.warning("Please select a data source first.");
      return;
    }

    setIsSending(true);
    setInputValue("");

    try {
      let conv = conversation;

      // Create conversation if needed
      if (!conv) {
        conv = await AIAssistant.createConversation({
          data_source_id: selectedDataSourceId,
        });
        setConversation(conv);
      }

      // Send the message
      const result = await AIAssistant.sendMessage(conv.id, {
        message: text,
        data_source_id: selectedDataSourceId,
      });

      const updatedConv = result.conversation;
      setConversation(updatedConv);
      setMessages(updatedConv.messages);

      // Auto-execute SQL if present in the response
      const lastMsg = updatedConv.messages[updatedConv.messages.length - 1];
      if (lastMsg && lastMsg.sql) {
        executeSQL(lastMsg.sql, updatedConv.messages.length - 1);
      }
    } catch (err) {
      const errorMsg =
        err.response?.data?.message || err.message || "Unknown error";
      notification.error("AI Assistant error: " + errorMsg);
    } finally {
      setIsSending(false);
    }
  }, [inputValue, isSending, selectedDataSourceId, conversation, executeSQL]);

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
    (sql, vizConfig, messageIndex) => {
      executeSQL(sql, messageIndex);
    },
    [executeSQL]
  );

  const handleSaveQuery = useCallback(
    async (sql, vizConfig) => {
      if (!selectedDataSourceId || !sql) return;

      try {
        const queryData = {
          name: conversation ? conversation.title : "AI Generated Query",
          query: sql,
          data_source_id: selectedDataSourceId,
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
    [selectedDataSourceId, conversation]
  );

  const handleNewConversation = useCallback(() => {
    setConversation(null);
    setMessages([]);
    setQueryResults({});
    setExecutingMessages({});
    setInputValue("");
  }, []);

  const handleDataSourceChange = useCallback(
    (dsId) => {
      setSelectedDataSourceId(dsId);
      try {
        localStorage.setItem("lastSelectedDataSourceId", dsId);
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
      {/* Header */}
      <div className="query-ai-header">
        <div className="query-ai-header__left">
          <h3>AI Query Builder</h3>
        </div>
        <div className="query-ai-header__right">
          <Select
            className="query-ai-ds-select"
            placeholder="Select Data Source"
            value={selectedDataSourceId}
            onChange={handleDataSourceChange}
            showSearch
            optionFilterProp="children">
            {dataSources.map((ds) => (
              <Option key={ds.id} value={ds.id}>
                {ds.name}
              </Option>
            ))}
          </Select>
          <Tooltip title="New Conversation">
            <Button onClick={handleNewConversation}>
              <i className="fa fa-plus" /> New Chat
            </Button>
          </Tooltip>
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
              onEditAndRun={(sql, vizConfig) => handleEditAndRun(sql, vizConfig, idx)}
              onSaveQuery={handleSaveQuery}
            />
          )
        )}

        {isSending && (
          <div className="ai-message ai-message--loading">
            <div className="ai-message__avatar ai-message__avatar--assistant">
              <i className="fa fa-magic" />
            </div>
            <div className="ai-message__bubble ai-message__bubble--assistant">
              <Spin size="small" /> Thinking...
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div className="query-ai-input">
        <TextArea
          placeholder={
            selectedDataSourceId
              ? "Describe what data you want to see..."
              : "Select a data source first..."
          }
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          autoSize={{ minRows: 1, maxRows: 4 }}
          disabled={isSending || !selectedDataSourceId}
        />
        <Button
          type="primary"
          disabled={!inputValue.trim() || isSending || !selectedDataSourceId}
          onClick={sendMessage}
          loading={isSending}>
          <i className="fa fa-paper-plane" />
        </Button>
      </div>
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
