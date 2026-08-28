from flask import Flask, jsonify, request
from flask_cors import CORS
import pandas as pd
import os
from langchain_experimental.agents import create_csv_agent, create_pandas_dataframe_agent
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
from dotenv import load_dotenv
import json
import re

load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

app = Flask(__name__)
CORS(app)

# Global variables
csv_file_path = 'geoark_attributes.csv'
df = None
chatbot = None

class VariableSearchAgent:
    def __init__(self, csv_filename, verbose=False):        
        self.llm = ChatGoogleGenerativeAI(
            model="gemini-2.5-flash",
            temperature=0,
            max_tokens=None,
            timeout=60,
            max_retries=2,
        )
        self.agent = create_pandas_dataframe_agent(
            self.llm, 
            csv_filename, 
            agent_type="zero-shot-react-description", 
            verbose=verbose, 
            allow_dangerous_code=True, 
            agent_executor_kwargs={'handle_parsing_errors': True}
        )
        
        self.system_prompt = """
You are a semantic search assistant for a database of variables/attributes from various datasets.

The CSV contains columns: dataset_id, attr_id, attr_label, attr_desc, tags, entity_type, start_date, end_date

Your task is to find the most relevant variables based on user search queries. 

When given a search query:
1. Understand the user's intent and what type of data they're looking for
2. Search through attr_label, attr_desc, and tags columns (case-insensitive)
3. Return the TOP 20 most relevant results
4. Consider semantic similarity - match based on meaning, not just exact keywords
5. Return results as a JSON array of objects with these exact fields:
   - dataset_id
   - attr_id
   - attr_label
   - attr_desc
   - tags
   - entity_type
   - start_date
   - end_date
   - relevance_score (0.0 to 1.0, where 1.0 is most relevant)

CRITICAL INSTRUCTIONS:
- Output ONLY valid JSON, no other text
- Return UP TO 20 results, ordered by relevance (most relevant first)
- If the query is empty or no matches found, return an empty array: []
- Calculate relevance_score based on how well the variable matches the query
- Consider synonyms and related concepts (e.g., "population" relates to "demographic", "census")
- When searching, convert text to lowercase to avoid case sensitivity issues
- Use python_repl_ast tool for data analysis

Example output format:
[
  {
    "dataset_id": "dataset1",
    "attr_id": "var001",
    "attr_label": "Population Density",
    "attr_desc": "Number of people per square kilometer",
    "tags": "['demographics', 'population']",
    "entity_type": "numeric",
    "start_date": "2020",
    "end_date": "2024",
    "relevance_score": 0.95
  }
]
"""
        
        self.messages = [
            SystemMessage(content=self.system_prompt),
        ]
    
    def reset(self):
        self.messages = [
            SystemMessage(content=self.system_prompt),
        ]

    def search(self, query):
        """Perform semantic search and return structured results"""
        if not query or query.strip() == "":
            return []
        
        # Create a detailed search prompt
        search_prompt = f"""
Find the top 20 most relevant variables for this search query: "{query}"

Steps:
1. Convert all text to lowercase for comparison
2. Search in attr_label, attr_desc, and tags columns
3. Consider semantic similarity (e.g., related terms and concepts)
4. Rank by relevance
5. Return top 20 results as JSON array

Return ONLY the JSON array, no explanatory text.
"""
        
        self.messages.append(HumanMessage(content=search_prompt))
        response = self.agent.invoke(self.messages)
        self.messages.append(AIMessage(content=response["output"]))
        
        # Parse the response to extract JSON
        return self._parse_response(response["output"])
    
    def _parse_response(self, response_text):
        """Parse LLM response to extract JSON array"""
        try:
            # Try to find JSON array in the response
            # Look for content between [ and ]
            json_match = re.search(r'\[.*\]', response_text, re.DOTALL)
            if json_match:
                json_str = json_match.group(0)
                results = json.loads(json_str)
                
                # Ensure all required fields are present and add defaults if missing
                processed_results = []
                for item in results[:20]:  # Limit to 20 results
                    processed_item = {
                        'dataset_id': item.get('dataset_id', ''),
                        'attr_id': item.get('attr_id', ''),
                        'attr_label': item.get('attr_label', ''),
                        'attr_desc': item.get('attr_desc', ''),
                        'tags': item.get('tags', ''),
                        'entity_type': item.get('entity_type', ''),
                        'start_date': item.get('start_date', ''),
                        'end_date': item.get('end_date', ''),
                        'similarity': round(item.get('relevance_score', 0.5), 3)
                    }
                    processed_results.append(processed_item)
                
                return processed_results
            else:
                print("No JSON array found in response")
                return []
                
        except json.JSONDecodeError as e:
            print(f"JSON parsing error: {e}")
            print(f"Response text: {response_text[:500]}")
            return []
        except Exception as e:
            print(f"Error parsing response: {e}")
            return []


def initialize_system():
    """Initialize the CSV agent at startup"""
    global df, chatbot
    
    try:

        global df
        # Use a reliable path relative to the script

        if not os.path.exists(csv_file_path):
            raise FileNotFoundError(f"CSV file not found at {csv_file_path}")

        script_dir = os.path.dirname(os.path.abspath(__file__))
        full_csv_path = os.path.join(script_dir, csv_file_path)

        # This line MUST succeed for the agent to work
        df = pd.read_csv(full_csv_path) 
        print(f"✅ Loaded {len(df)} variables from CSV")
        # Check the size (Print this in your actual app)
        print(f"✅ DataFrame loaded. Rows: {len(df)}") 

        global chatbot
        chatbot = VariableSearchAgent(df, verbose=True)
                
        print("✅ Semantic search system ready!")
        return True
        
    except Exception as e:
        print(f"❌ Failed to initialize system: {str(e)}")
        print("Make sure you have:")
        print("1. GOOGLE_API_KEY in your .env file")
        print("2. CSV file at correct location")
        print("3. Required packages: flask, flask-cors, pandas, langchain, langchain-google-genai, python-dotenv")
        return False


@app.route('/api/search', methods=['GET'])
def search():
    """Main search endpoint - compatible with server.js API"""
    try:
        if chatbot is None:
            return jsonify({
                "error": "System not initialized. Please wait for startup to complete."
            }), 503
        
        query = request.args.get('q', '').strip()
        
        if not query:
            return jsonify([])
        
        print(f"🔍 Searching for: '{query}'")
        
        # Reset chatbot for fresh search
        chatbot.reset()
        
        # Perform search
        results = chatbot.search(query)
        
        print(f"📊 Found {len(results)} results")
        if results:
            print(f"   Top result: {results[0].get('attr_label', 'N/A')} (similarity: {results[0].get('similarity', 0)})")
        
        return jsonify(results)
        
    except Exception as e:
        print(f"❌ Search error: {str(e)}")
        return jsonify({
            "error": "Search failed",
            "details": str(e)
        }), 500


@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint - compatible with server.js API"""
    return jsonify({
        "status": "ok",
        "embeddingsReady": chatbot is not None,
        "variableCount": len(df) if df is not None else 0,
        "embeddingCount": len(df) if df is not None else 0,
        "model": "gemini-2.0-flash-thinking-exp-01-21"
    })


@app.route('/api/mock-search', methods=['GET'])
def mock_search():
    """Fallback endpoint for backward compatibility"""
    query = request.args.get('q', '').lower()
    
    # Return empty for now, or implement basic filtering
    return jsonify([])


if __name__ == '__main__':
    print("=" * 60)
    print("🚀 Starting Semantic Search Server with LangChain + Gemini")
    print("=" * 60)
    
    if initialize_system():
        print("\n" + "=" * 60)
        print("📖 API Endpoints:")
        print("   GET /api/search?q=your+query")
        print("   GET /api/health")
        print("   GET /api/mock-search?q=your+query (fallback)")
        print("=" * 60)
        print("\n🌐 Server starting on http://localhost:4001\n")
        
        app.run(debug=True, port=4001, host='0.0.0.0')
    else:
        print("\n❌ Failed to start server due to initialization errors")
        exit(1)
