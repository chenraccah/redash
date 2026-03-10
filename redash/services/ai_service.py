import json
import logging
import re
import time

import requests

from redash import settings

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a SQL expert and data visualization advisor embedded in Redash.
Users describe what data they want to see, and you write the SQL query AND choose the best visualization for it.

LANGUAGE RULE: Always respond in the SAME language the user writes in. Match the user's language exactly.
If the user writes in Hebrew:
- Your ENTIRE response MUST be in Hebrew — every word, including explanations, clarifying questions, bullet points, and option labels.
- Chart titles, counter labels, chart names, and axis labels MUST all be in Hebrew.
- Do NOT mix English words into Hebrew sentences. Translate technical terms too (e.g., "revenue" → "הכנסות", "orders" → "הזמנות", "customers" → "לקוחות").
- The ONLY exception is table names and column names from the schema — those should stay in their original form when referenced in SQL or when quoting a specific column name.
If the user writes in English, respond in English.

CLARIFICATION RULE:
Prefer generating a query over asking questions. Only ask for clarification when there is a genuine ambiguity in the schema that would lead to wrong results — for example:
- The user says "revenue" but the schema has both `orders.total_amount` and `orders.net_amount` — ask which one
- The user says "users" but there are `customers`, `employees`, and `users` tables — ask which one
- The user says "date" but the table has `created_at`, `updated_at`, and `shipped_at` — ask which one

When you do ask:
- Ask exactly ONE short question with 2-3 concrete options from the schema
- Do NOT include any ```sql or ```visualization code blocks
- Do NOT ask about time ranges, grouping, chart types, or limits — just pick reasonable defaults

Do NOT ask clarifying questions when:
- You can make a reasonable guess from context — just go with it
- The user is responding to your previous question — generate the query now
- The user asks to modify a previous query or visualization
- An error context is provided — fix the error instead

AVAILABLE DATA SOURCES:
{schema}

DATA SOURCE TYPE: {db_type}

RULES:
1. Generate valid SQL for the {db_type} dialect. Use only tables and columns from the schema above.
2. Always output your SQL inside a ```sql code block FIRST, before any other text.
3. Always output a visualization config inside a ```visualization code block as valid JSON, immediately after the SQL block.
4. Choose the BEST visualization type for the data:
   - Single aggregate number (COUNT, SUM, AVG) -> COUNTER
   - Time series / trends over time -> CHART with globalSeriesType "line"
   - Comparisons / rankings / categories -> CHART with globalSeriesType "column"
   - Proportions / parts of a whole -> CHART with globalSeriesType "pie"
   - Raw data listing / many columns -> TABLE
5. After the code blocks, include AT MOST one brief sentence of explanation. Do NOT include multi-sentence explanations.
6. NEVER start with preamble like "Here is a query...", "Sure!", "I can help...", etc. Start directly with the ```sql block.
7. If a query error is provided, analyze it and return a corrected query.
8. If the user asks to change the visualization, keep the same SQL and change the visualization config.
9. When multiple data sources are available, specify which data source a query targets by adding `-- DATA_SOURCE: <name>` as the FIRST line of the SQL block.

CRITICAL VISUALIZATION RULES (charts MUST NOT be blank):
- Every SQL SELECT column MUST have an explicit alias using AS.
- The columnMapping keys MUST be the EXACT aliases from your SELECT clause (case-sensitive).
- For CHART: you need at least one "x" mapping and one "y" mapping. Map the category/date column to "x" and the numeric/aggregate column(s) to "y".
- For multiple Y series: map each numeric column to "y" — e.g., {{"month": "x", "revenue": "y", "cost": "y"}}.
- For pie charts: map the label column to "x" and the value column to "y".
- COUNTER: counterColName must match the exact alias of the numeric column.
- NEVER use column names that don't appear in your SELECT aliases.
- Always include ORDER BY for time series to ensure correct chart rendering.
- Limit results to a reasonable number (e.g., LIMIT 50 for bar charts, LIMIT 20 for pie) so charts are readable.

VISUALIZATION JSON FORMAT:
For CHART type:
```visualization
{{
  "type": "CHART",
  "name": "Descriptive Chart Title",
  "options": {{
    "globalSeriesType": "column",
    "columnMapping": {{"x_alias": "x", "y_alias": "y"}},
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
    "counterLabel": "Label text",
    "counterColName": "exact_alias_from_select",
    "rowNumber": 1,
    "targetRowNumber": null,
    "stringDecimal": 0,
    "stringDecChar": ".",
    "stringThouSep": ","
  }}
}}
```

EXAMPLE 1 — "show me total revenue per month" (line chart):
```sql
SELECT DATE_TRUNC('month', order_date) AS month, SUM(amount) AS total_revenue
FROM orders
GROUP BY month
ORDER BY month;
```
```visualization
{{"type": "CHART", "name": "Monthly Revenue", "options": {{"globalSeriesType": "line", "columnMapping": {{"month": "x", "total_revenue": "y"}}, "legend": {{"enabled": false, "placement": "auto"}}, "xAxis": {{"type": "-", "labels": {{"enabled": true}}}}, "yAxis": [{{"type": "linear"}}], "series": {{"stacking": null}}, "numberFormat": "0,0[.]00", "missingValuesAsZero": true}}}}
```

EXAMPLE 2 — "how many users per country" (bar chart):
```sql
SELECT country AS country, COUNT(*) AS user_count
FROM users
GROUP BY country
ORDER BY user_count DESC
LIMIT 20;
```
```visualization
{{"type": "CHART", "name": "Users by Country", "options": {{"globalSeriesType": "column", "columnMapping": {{"country": "x", "user_count": "y"}}, "legend": {{"enabled": false, "placement": "auto"}}, "xAxis": {{"type": "-", "labels": {{"enabled": true}}}}, "yAxis": [{{"type": "linear"}}], "series": {{"stacking": null}}, "numberFormat": "0,0", "missingValuesAsZero": true}}}}
```

EXAMPLE 3 — "total number of orders" (counter):
```sql
SELECT COUNT(*) AS total_orders FROM orders;
```
```visualization
{{"type": "COUNTER", "name": "Total Orders", "options": {{"counterLabel": "Total Orders", "counterColName": "total_orders", "rowNumber": 1, "targetRowNumber": null, "stringDecimal": 0, "stringDecChar": ".", "stringThouSep": ","}}}}
```

EXAMPLE 4 — Hebrew: "הראה לי את ההכנסות לפי חודש":
```sql
SELECT DATE_TRUNC('month', order_date) AS month, SUM(amount) AS total_revenue
FROM orders
GROUP BY month
ORDER BY month;
```
```visualization
{{"type": "CHART", "name": "הכנסות לפי חודש", "options": {{"globalSeriesType": "line", "columnMapping": {{"month": "x", "total_revenue": "y"}}, "legend": {{"enabled": false, "placement": "auto"}}, "xAxis": {{"type": "-", "labels": {{"enabled": true}}}}, "yAxis": [{{"type": "linear"}}], "series": {{"stacking": null}}, "numberFormat": "0,0[.]00", "missingValuesAsZero": true}}}}
```
הכנסות חודשיות מסודרות לפי זמן.
"""


def _format_single_schema(schema, max_tables):
    """Format a single data source's schema into readable text."""
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


def format_schema_for_prompt(schema, max_tables=None):
    """Convert Redash schema format to LLM-readable text.

    schema can be:
      - a list of tables (single data source, legacy)
      - a dict of {ds_id: {name, schema, db_type}} (multi data source)
    """
    if max_tables is None:
        max_tables = settings.AI_MAX_SCHEMA_TABLES

    if isinstance(schema, dict):
        sections = []
        for ds_id, ds_info in schema.items():
            ds_name = ds_info.get("name", f"Data Source {ds_id}")
            ds_schema = ds_info.get("schema", [])
            ds_db_type = ds_info.get("db_type", "sql")
            section = f"--- Data Source: {ds_name} (type: {ds_db_type}) ---\n"
            ds_desc = ds_info.get("description", "")
            if ds_desc:
                section += f"Description: {ds_desc}\n"
            section += _format_single_schema(ds_schema, max_tables)
            sections.append(section)
        return "\n\n".join(sections)

    return _format_single_schema(schema, max_tables)


def build_messages(conversation_messages, schema_text, db_type):
    """Build the chat messages array from conversation history."""
    system_content = SYSTEM_PROMPT.format(schema=schema_text, db_type=db_type)
    messages = [{"role": "system", "content": system_content}]

    for msg in conversation_messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role in ("user", "assistant"):
            messages.append({"role": role, "content": content})

    return messages


def call_llm(messages):
    """Call the AI Gateway chat completion API."""
    base_url = settings.AI_LLM_BASE_URL.rstrip("/")
    model = settings.AI_LLM_MODEL

    headers = {
        "Content-Type": "application/json",
    }

    api_key = settings.AI_LLM_API_KEY
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": model,
        "messages": messages,
        "temperature": settings.AI_LLM_TEMPERATURE,
        "max_tokens": settings.AI_LLM_MAX_TOKENS,
        "stream": False,
    }

    timeout = settings.AI_LLM_TIMEOUT
    max_retries = 2

    for attempt in range(max_retries + 1):
        try:
            response = requests.post(
                f"{base_url}/chat/completions",
                headers=headers,
                json=payload,
                timeout=timeout,
            )
            response.raise_for_status()

            try:
                data = response.json()
                return data["choices"][0]["message"]["content"]
            except (json.JSONDecodeError, KeyError, IndexError) as e:
                raise ValueError(f"Invalid response from AI Gateway: {e}")

        except requests.exceptions.ConnectionError:
            if attempt < max_retries:
                logger.warning(
                    "AI Gateway connection failed (attempt %d/%d), retrying in 2s...",
                    attempt + 1,
                    max_retries + 1,
                )
                time.sleep(2)
                continue
            raise ValueError(
                "Cannot connect to AI Gateway. "
                "Check that REDASH_AI_LLM_BASE_URL is correct and the service is reachable."
            )
        except requests.exceptions.Timeout:
            if attempt < max_retries:
                logger.warning(
                    "AI Gateway request timed out (attempt %d/%d), retrying...",
                    attempt + 1,
                    max_retries + 1,
                )
                continue
            raise ValueError(
                f"AI Gateway request timed out after {timeout}s. "
                "Try again shortly or increase REDASH_AI_LLM_TIMEOUT."
            )
        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code == 404:
                raise ValueError(
                    f"Model '{model}' not found. "
                    f"Check REDASH_AI_LLM_MODEL is correct."
                )
            raise


def _try_fix_json(raw_json):
    """Attempt to fix common JSON issues from local models."""
    # Remove trailing commas before closing braces/brackets
    fixed = re.sub(r",\s*([}\]])", r"\1", raw_json)
    # Remove single-line comments
    fixed = re.sub(r"//.*$", "", fixed, flags=re.MULTILINE)
    return fixed


def _extract_sql_aliases(sql):
    """Extract column aliases from a SQL SELECT clause.

    Looks for 'AS alias' patterns to determine the output column names.
    Falls back to bare column names if no aliases found.
    """
    if not sql:
        return []
    # Find the SELECT ... FROM portion
    select_match = re.search(r"SELECT\s+(.*?)\s+FROM\s", sql, re.DOTALL | re.IGNORECASE)
    if not select_match:
        return []
    select_clause = select_match.group(1)
    # Extract 'AS alias' patterns
    aliases = re.findall(r"\bAS\s+(\w+)", select_clause, re.IGNORECASE)
    if aliases:
        return [a.lower() for a in aliases]
    # Fallback: split by comma and take last word of each part
    parts = [p.strip().split()[-1].strip('"\'`') for p in select_clause.split(",")]
    return [p.lower() for p in parts if p]


def parse_llm_response(content):
    """Parse the LLM response to extract SQL, visualization config, and target data source."""
    result = {
        "content": content,
        "sql": None,
        "visualization": None,
        "target_data_source": None,
        "is_clarification": False,
    }

    # Extract SQL from ```sql ... ``` blocks
    sql_pattern = r"```sql\s*\n?(.*?)\n?\s*```"
    sql_matches = re.findall(sql_pattern, content, re.DOTALL | re.IGNORECASE)
    if sql_matches:
        raw_sql = sql_matches[-1].strip()

        # Extract -- DATA_SOURCE: <name> from first line
        ds_match = re.match(r"^--\s*DATA_SOURCE:\s*(.+)", raw_sql)
        if ds_match:
            result["target_data_source"] = ds_match.group(1).strip()
            # Remove the DATA_SOURCE comment from the SQL
            raw_sql = raw_sql[ds_match.end():].strip()

        result["sql"] = raw_sql

    # Extract visualization from ```visualization ... ``` blocks
    viz_pattern = r"```visualization\s*\n?(.*?)\n?\s*```"
    viz_matches = re.findall(viz_pattern, content, re.DOTALL | re.IGNORECASE)
    if viz_matches:
        raw_viz = viz_matches[-1].strip()
        try:
            result["visualization"] = json.loads(raw_viz)
        except json.JSONDecodeError:
            # Local models sometimes produce slightly malformed JSON — try to fix
            try:
                result["visualization"] = json.loads(_try_fix_json(raw_viz))
                logger.info("Fixed malformed visualization JSON from LLM")
            except json.JSONDecodeError:
                logger.warning(
                    "Failed to parse visualization config from LLM response: %s",
                    raw_viz[:200],
                )
    elif result["sql"]:
        # Local models sometimes skip the visualization block — default to TABLE
        result["visualization"] = {
            "type": "TABLE",
            "name": "Result",
            "options": {},
        }

    # Validate and fix visualization
    if result["visualization"]:
        viz = result["visualization"]
        if "type" not in viz:
            viz["type"] = "TABLE"
        if viz["type"] not in ("CHART", "TABLE", "COUNTER"):
            viz["type"] = "TABLE"
        if "name" not in viz:
            viz["name"] = "Result"
        if "options" not in viz:
            viz["options"] = {}

        opts = viz["options"]

        # For CHART: ensure columnMapping has at least x and y
        if viz["type"] == "CHART":
            cm = opts.get("columnMapping", {})
            has_x = "x" in cm.values()
            has_y = "y" in cm.values()

            # If columnMapping is missing or incomplete, try to build from SQL aliases
            if not has_x or not has_y:
                aliases = _extract_sql_aliases(result.get("sql", ""))
                if aliases and len(aliases) >= 2:
                    cm = {aliases[0]: "x"}
                    for a in aliases[1:]:
                        cm[a] = "y"
                    opts["columnMapping"] = cm
                    logger.info("Auto-fixed columnMapping from SQL aliases: %s", cm)
                elif not cm:
                    # Can't determine mapping, fall back to TABLE
                    viz["type"] = "TABLE"
                    viz["options"] = {}

            # Ensure required chart sub-options exist
            if viz["type"] == "CHART":
                opts.setdefault("globalSeriesType", "column")
                opts.setdefault("legend", {"enabled": True, "placement": "auto"})
                opts.setdefault("xAxis", {"type": "-", "labels": {"enabled": True}})
                opts.setdefault("yAxis", [{"type": "linear"}])
                opts.setdefault("series", {"stacking": None})
                opts.setdefault("missingValuesAsZero", True)

        # For COUNTER: ensure counterColName is set
        if viz["type"] == "COUNTER" and not opts.get("counterColName"):
            aliases = _extract_sql_aliases(result.get("sql", ""))
            if aliases:
                opts["counterColName"] = aliases[-1]  # last alias is usually the aggregate
                opts.setdefault("rowNumber", 1)

    # If no SQL was generated, this is a clarification question
    if not result["sql"]:
        result["is_clarification"] = True

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

    messages = build_messages(all_messages, schema_text, db_type)
    raw_response = call_llm(messages)
    return parse_llm_response(raw_response)
