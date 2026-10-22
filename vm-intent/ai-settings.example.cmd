@echo off
REM AI settings for vm-intent, read by 2-start-backend.cmd and 5-start-worker.cmd.
REM
REM   1. Copy this file to ai-settings.cmd (in this same folder).
REM   2. In the copy, remove "REM " from the lines of ONE provider below and fill them in.
REM   3. Restart the backend (close its window, double-click 2-start-backend.cmd).
REM
REM ai-settings.cmd is git-ignored, so API keys you put there stay on this PC.
REM With no provider set, the built-in rules interpret requests (offline, free).
REM Whatever you pick, the rules still answer if the AI is down or slow, and each
REM result says which one answered ("interpreted by ai:ollama/llama3.2" or "rules").

REM ---- Ollama: free, runs on this PC, nothing leaves your network --------------
REM Install from https://ollama.com, then in a terminal: ollama pull llama3.2
REM set VMINTENT_LLM_PROVIDER=ollama
REM set VMINTENT_LLM_MODEL=llama3.2
REM Ollama on another machine:  set VMINTENT_LLM_URL=http://gpu-box:11434

REM ---- Claude (Anthropic) -----------------------------------------------------
REM set VMINTENT_LLM_PROVIDER=anthropic
REM set VMINTENT_LLM_API_KEY=sk-ant-...
REM set VMINTENT_LLM_MODEL=claude-sonnet-5-5

REM ---- OpenAI, or any OpenAI-compatible service -------------------------------
REM set VMINTENT_LLM_PROVIDER=openai
REM set VMINTENT_LLM_API_KEY=sk-...
REM set VMINTENT_LLM_MODEL=<a model from your provider's list>
REM Another OpenAI-compatible service:  set VMINTENT_LLM_URL=https://api.example.com/v1

REM ---- Azure OpenAI -----------------------------------------------------------
REM set VMINTENT_LLM_PROVIDER=azure-openai
REM set VMINTENT_LLM_URL=https://<your-resource>.openai.azure.com
REM set VMINTENT_LLM_API_KEY=<key from the Azure portal: Keys and Endpoint>
REM set VMINTENT_LLM_MODEL=<your deployment name>
