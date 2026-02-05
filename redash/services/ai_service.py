import json
import logging
import re

import requests

from redash import settings

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a SQL expert and data visualization advisor embedded in Redash.
Users describe what data they want to see, and you write the SQL query AND choose the best visualization for it.

DATABASE SCHEMA:
{schema}

DATA SOURCE TYPE: {db_type}

RULES:
1. Generate valid SQL for the {db_type} dialect. Use only tables and columns from the schema above.
2. Always output your SQL inside a ```sql code block.
3. Always output a visualization config inside a ```visualization code block as valid JSON.
4. Choose the BEST visualization type for the data:
   - Single aggregate number -> COUNTER
   - Time series data -> CHART with globalSeriesType "line"
   - Comparisons/rankings -> CHART with globalSeriesType "column"
   - Proportions/distribution -> CHART with globalSeriesType "pie"
   - Raw data / many columns -> TABLE
5. Keep text explanations brief. Focus on delivering results.
6. If a query error is provided, analyze it and return a corrected query.
7. If the user asks to change the visualization, keep the same SQL and change the visualization config.

VISUALIZATION JSON FORMAT:
For CHART type:
```visualization
{{
  "type": "CHART",
  "name": "Descriptive Chart Title",
  "options": {{
    "globalSeriesType": "column",
    "columnMapping": {{"column_name_for_x": "x", "column_name_for_y": "y"}},
    "legend": {{"enabled": true, "placement": "auto"}},
    "xAxis": {{"type": "-", "labels": {{"enabled": true}}}},
    "yAxis": [{{"type": "linear"}}],
    "series": {{"stacking": null}},
    "numberFormat": "0,0[.]00",
    "missingValuesAsZero": true
  }}
}}
```

For TABLE type:
```visualization
{{"type": "TABLE", "name": "Results Table", "options": {{}}}}
```

For COUNTER type:
```visualization
{{
  "type": "COUNTER",
  "name": "Counter Title",
  "options": {{
    "counterLabel": "Label",
    "counterColName": "column_name",
    "rowNumber": 1,
    "targetRowNumber": null,
    "stringDecimal": 0,
    "stringDecChar": ".",
    "stringThouSep": ","
  }}
}}
```

IMPORTANT: The columnMapping keys MUST match the exact column names/aliases in your SQL SELECT clause.
"""


def format_schema_for_prompt(schema, max_tables=None):
    """Convert Redash schema format to LLM-readable text."""
    if max_tables is None:
        max_tables = settings.AI_MAX_SCHEMA_TABLES

    lines = []
    for table in schema[:max_tables]:
        table_name = table.get("name", "")
        columns = table.get("columns", [])
        col_parts = []
        for col in columns:
            if isinstance(col, dict):
                name = col.get("name", "")
                col_type = col.get("type", "")
                col_parts.append(
                    f"  {name} ({col_type})" if col_type else f"  {name}"
                )
            else:
                col_parts.append(f"  {col}")
        lines.append(f"{table_name}: {', '.join(col_parts)}")

    if len(schema) > max_tables:
        lines.append(f"... and {len(schema) - max_tables} more tables")

    return "\n".join(lines)


def build_messages(conversation_messages, schema_text, db_type):
    """Build the OpenAI messages array from conversation history."""
    system_content = SYSTEM_PROMPT.format(schema=schema_text, db_type=db_type)
    messages = [{"role": "system", "content": system_content}]

    for msg in conversation_messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role in ("user", "assistant"):
            messages.append({"role": role, "content": content})

    return messages


def call_openai(messages):
    """Call the OpenAI Chat Completion API."""
    api_key = settings.AI_OPENAI_API_KEY
    if not api_key:
        raise ValueError(
            "OpenAI API key not configured. Set REDASH_AI_OPENAI_API_KEY."
        )

    base_url = settings.AI_OPENAI_BASE_URL.rstrip("/")
    model = settings.AI_OPENAI_MODEL

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.1,
        "max_tokens": 4096,
    }

    response = requests.post(
        f"{base_url}/chat/completions",
        headers=headers,
        json=payload,
        timeout=120,
    )
    response.raise_for_status()

    data = response.json()
    return data["choices"][0]["message"]["content"]


def parse_llm_response(content):
    """Parse the LLM response to extract SQL and visualization config."""
    result = {
        "content": content,
        "sql": None,
        "visualization": None,
    }

    # Extract SQL from ```sql ... ``` blocks
    sql_pattern = r"```sql\s*\n?(.*?)\n?\s*```"
    sql_matches = re.findall(sql_pattern, content, re.DOTALL | re.IGNORECASE)
    if sql_matches:
        result["sql"] = sql_matches[-1].strip()

    # Extract visualization from ```visualization ... ``` blocks
    viz_pattern = r"```visualization\s*\n?(.*?)\n?\s*```"
    viz_matches = re.findall(viz_pattern, content, re.DOTALL | re.IGNORECASE)
    if viz_matches:
        try:
            result["visualization"] = json.loads(viz_matches[-1].strip())
        except json.JSONDecodeError:
            logger.warning("Failed to parse visualization config from LLM response")

    return result


def generate_response(
    user_message, conversation_messages, schema, db_type, error_context=None
):
    """Main entry point: generate an AI response for a user message."""
    schema_text = format_schema_for_prompt(schema)

    if error_context:
        user_message = (
            f"{user_message}\n\n"
            f"The previous query returned this error:\n{error_context}"
        )

    all_messages = list(conversation_messages) + [
        {"role": "user", "content": user_message}
    ]

    max_msgs = settings.AI_MAX_CONVERSATION_MESSAGES
    if len(all_messages) > max_msgs:
        all_messages = all_messages[-max_msgs:]

    openai_messages = build_messages(all_messages, schema_text, db_type)
    raw_response = call_openai(openai_messages)
    return parse_llm_response(raw_response)
