import * as vscode from 'vscode';
import OpenAI from "openai";
import { encodingForModel } from "js-tiktoken";


type AuthInfo = { apiKey?: string };
type Settings = {
	selectedInsideCodeblock?: boolean,
	codeblockWithLanguageId?: false,
	pasteOnClick?: boolean,
	keepConversation?: boolean,
	timeoutLength?: number,
	model?: string,
	maxModelTokens?: number,
	maxResponseTokens?: number,
	apiUrl?: string
};


const BASE_URL = 'https://api.openai.com/v1';

export function activate(context: vscode.ExtensionContext) {

	console.log('activating extension "chatgpt"');
	// Get the settings from the extension's configuration
	const config = vscode.workspace.getConfiguration('chatgpt');

	// Create a new ChatGPTViewProvider instance and register it with the extension's context
	const provider = new ChatGPTViewProvider(context.extensionUri);

	// Put configuration settings into the provider
	provider.setAuthenticationInfo({
		apiKey: config.get('apiKey')
	});
	
	provider.setSettings({
		selectedInsideCodeblock: config.get('selectedInsideCodeblock') || false,
		codeblockWithLanguageId: config.get('codeblockWithLanguageId') || false,
		pasteOnClick: config.get('pasteOnClick') || false,
		keepConversation: config.get('keepConversation') || false,
		timeoutLength: config.get('timeoutLength') || 60,
		apiUrl: config.get('apiUrl') || BASE_URL,
		model: config.get('model') || 'gpt-3.5-turbo',
		maxModelTokens: config.get('maxModelTokens') || 4000,
		maxResponseTokens: config.get('maxResponseTokens') || 1000
	});
	// Register the provider with the extension's context
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatGPTViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);


	const commandHandler = (command: string) => {
		const config = vscode.workspace.getConfiguration('chatgpt');
		const prompt = config.get(command) as string;
		provider.search(prompt);
	};

	// Register the commands that can be called from the extension's package.json
	context.subscriptions.push(
		vscode.commands.registerCommand('chatgpt.ask', () =>
			vscode.window.showInputBox({ prompt: 'What do you want to do?' })
				.then((value) => provider.search(value))
		),
		vscode.commands.registerCommand('chatgpt.explain', () => commandHandler('promptPrefix.explain')),
		vscode.commands.registerCommand('chatgpt.refactor', () => commandHandler('promptPrefix.refactor')),
		vscode.commands.registerCommand('chatgpt.optimize', () => commandHandler('promptPrefix.optimize')),
		vscode.commands.registerCommand('chatgpt.findProblems', () => commandHandler('promptPrefix.findProblems')),
		vscode.commands.registerCommand('chatgpt.documentation', () => commandHandler('promptPrefix.documentation')),
		vscode.commands.registerCommand('chatgpt.resetConversation', () => provider.resetConversation())
	);


	// Change the extension's session token or settings when configuration is changed
	vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
		if (event.affectsConfiguration('chatgpt.apiKey')) {
			const config = vscode.workspace.getConfiguration('chatgpt');
			provider.setAuthenticationInfo({ apiKey: config.get('apiKey') });
		} else if (event.affectsConfiguration('chatgpt.apiUrl')) {
			const config = vscode.workspace.getConfiguration('chatgpt');
			let url = config.get('apiUrl') as string || BASE_URL;
			provider.setSettings({ apiUrl: url });
		} else if (event.affectsConfiguration('chatgpt.model')) {
			const config = vscode.workspace.getConfiguration('chatgpt');
			provider.setSettings({ model: config.get('model') || 'gpt-3.5-turbo' });
		} else if (event.affectsConfiguration('chatgpt.maxModelTokens')) {
			const config = vscode.workspace.getConfiguration('chatgpt');
			provider.setSettings({ maxModelTokens: config.get('maxModelTokens') || 4000 });
		} else if (event.affectsConfiguration('chatgpt.maxResponseTokens')) {
			const config = vscode.workspace.getConfiguration('chatgpt');
			provider.setSettings({ maxResponseTokens: config.get('maxResponseTokens') || 4000 });
		} else if (event.affectsConfiguration('chatgpt.selectedInsideCodeblock')) {
			const config = vscode.workspace.getConfiguration('chatgpt');
			provider.setSettings({ selectedInsideCodeblock: config.get('selectedInsideCodeblock') || false });
		} else if (event.affectsConfiguration('chatgpt.codeblockWithLanguageId')) {
			const config = vscode.workspace.getConfiguration('chatgpt');
			provider.setSettings({ codeblockWithLanguageId: config.get('codeblockWithLanguageId') || false });
		} else if (event.affectsConfiguration('chatgpt.pasteOnClick')) {
			const config = vscode.workspace.getConfiguration('chatgpt');
			provider.setSettings({ pasteOnClick: config.get('pasteOnClick') || false });
		} else if (event.affectsConfiguration('chatgpt.keepConversation')) {
			const config = vscode.workspace.getConfiguration('chatgpt');
			provider.setSettings({ keepConversation: config.get('keepConversation') || false });
		} else if (event.affectsConfiguration('chatgpt.timeoutLength')) {
			const config = vscode.workspace.getConfiguration('chatgpt');
			provider.setSettings({ timeoutLength: config.get('timeoutLength') || 60 });
		}
	});
}


interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  selected: boolean;
}

class ChatGPTViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'chatgpt.chatView';
	private _view?: vscode.WebviewView;

	//private _chatGPTAPI?: ChatGPTAPI;
	private _conversation?: any;
	private _messages?: Message[];
	private _openai?: OpenAI;

	private _response?: string;
	private _totalNumberOfTokens?: number;
	private _prompt?: string;
	private _fullPrompt?: string;
	private _currentMessageNumber = 0;
	private _enc = encodingForModel("gpt-4"); //Hardcoded for now

	private _settings: Settings = {
		selectedInsideCodeblock: false,
		codeblockWithLanguageId: false,
		pasteOnClick: true,
		keepConversation: true,
		timeoutLength: 60,
		apiUrl: BASE_URL,
		model: 'gpt-3.5-turbo',
		maxModelTokens: 4000,
		maxResponseTokens: 1000
	};
	private _authInfo?: AuthInfo;

	// In the constructor, we store the URI of the extension
	constructor(private readonly _extensionUri: vscode.Uri) {
		this._messages = [];
		this._messages?.push({ role: "system", content: "You are a helpful assistant.", selected:true });
		console.log("constructor....");
		console.log("messages:", this._messages);
	}

	// Set the API key and create a new API instance based on this key
	public setAuthenticationInfo(authInfo: AuthInfo) {
		this._authInfo = authInfo;
		this._newAPI();
	}

	public setSettings(settings: Settings) {
		let changeModel = false;
		if (settings.apiUrl || settings.model || settings.maxModelTokens || settings.maxResponseTokens) {
			changeModel = true;
		}
		this._settings = { ...this._settings, ...settings };

		if (changeModel) {
			//this._newAPI();
		}
	}

	public getSettings() {
		return this._settings;
	}

	// This private method initializes a new ChatGPTAPI instance
	private _newAPI() {
		console.log("New API");
		console.log("Messages:", this._messages);
		if (!this._authInfo || !this._settings?.apiUrl) {
			console.warn("API key or API URL not set, please go to extension settings (read README.md for more info)");
		} else {
			this._openai = new OpenAI(
				{
					apiKey: this._authInfo?.apiKey
				}
			);
		}
		setTimeout(() => {
			const chat_response = this._updateChatMessages(
				this._getMessagesNumberOfTokens(),
				0
			);
			this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
		}, 2000);
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		// set options for the webview, allow scripts
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this._extensionUri
			]
		};

		// set the HTML for the webview
		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		// add an event listener for messages received by the webview
		webviewView.webview.onDidReceiveMessage(async data =>  {
			switch (data.type) {
				case 'codeSelected':
					{
						// do nothing if the pasteOnClick option is disabled
						if (!this._settings.pasteOnClick) {
							break;
						}
						let code = data.value;
						const snippet = new vscode.SnippetString();
						snippet.appendText(code);
						// insert the code as a snippet into the active text editor
						vscode.window.activeTextEditor?.insertSnippet(snippet);
						break;
					}
				case 'prompt':
					{
						console.log("prompt");
						this.search(data.value);
						break;
					}
				case 'promptNoQuery':
					{
						console.log("promptNoQuery");

						let searchPrompt = await this._generate_search_prompt(data.value);
						
						this._messages?.push({ role: "user", content: searchPrompt, selected:true })
						let chat_response = this._updateChatMessages(
							this._getMessagesNumberOfTokens(),
							0
						);
						this._response = chat_response;
						this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
						break;
					}
				case 'checkboxChanged':
					{
						console.log("checkboxChanged:", data);
						const idParts = data.id.split('-'); // Split the id into parts
						if(idParts.length === 3) {
							const indexStr = idParts[2]; // Grab the last part, which should contain the index
							const index = parseInt(indexStr, 10); // Convert the index to an integer and adjust if necessary
						
							if(this._messages && index >= 0 && index < this._messages.length) {
								// If the index is within the bounds of the array, update the checked status
								this._messages[index].selected = data.checked;
							} else {
								// Handle cases where index is out of bounds or _messages is not an array
								console.error('Index is out of bounds or _messages is not properly defined.');
							}
						} else {
							// Handle cases where data.id does not follow the expected format
							console.error('data.id is not in the expected format.');
						}
						break;
					}
				case 'messageContentChanged':
					{
						console.log("messageContentChanged:", data);
						const idParts = data.id.split('-'); // Split the id into parts
						if(idParts.length === 3) {
							const indexStr = idParts[2]; // Grab the last part, which should contain the index
							const index = parseInt(indexStr, 10); // Convert the index to an integer and adjust if necessary
						
							if(this._messages && index >= 0 && index < this._messages.length) {
								// If the index is within the bounds of the array, update the checked status
								this._messages[index].content = data.value;
							} else {
								// Handle cases where index is out of bounds or _messages is not an array
								console.error('Index is out of bounds or _messages is not properly defined.');
							}
						} else {
							// Handle cases where data.id does not follow the expected format
							console.error('data.id is not in the expected format.');
						}
						console.log("messages:", this._messages);
						break;
					}
			}
		});
	}


	public async resetConversation() {
		console.log(this, this._conversation);
		if (this._conversation) {
			this._conversation = null;
		}
		this._prompt = '';
		this._response = '';
		this._fullPrompt = '';
		this._totalNumberOfTokens = 0;
		this._view?.webview.postMessage({ type: 'setPrompt', value: '' });
		this._messages = [];
		this._messages?.push({ role: "system", content: "You are a helpful assistant.", selected:true });
		const chat_response = this._updateChatMessages(
			this._getMessagesNumberOfTokens(),
			0
		);
		this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
	}

	public fixCodeBlocks(response: string) {
		// Use a regular expression to find all occurrences of the substring in the string
		const REGEX_CODEBLOCK = new RegExp('\`\`\`', 'g');
		const matches = response.match(REGEX_CODEBLOCK);

		// Return the number of occurrences of the substring in the response, check if even
		const count = matches ? matches.length : 0;
		if (count % 2 === 0) {
			return response;
		} else {
			// else append ``` to the end to make the last code block complete
			console.log("Warning - code block not complete");
			return response.concat('\n\`\`\`');
		}

	}

	private _getMessagesNumberOfTokens() {
		
		let full_promt = "";
		if (this._messages) {
			for (const message of this._messages) {
				if (message.selected) {
					full_promt += "\n# <u>" + message.role.toUpperCase() + "</u>:\n" + message.content;
				}
			}
		}

		const tokenList = this._enc.encode(full_promt);
		return tokenList.length;
	}


	
	public getSelectedMessagesWithoutSelectedProperty(): Omit<Message, 'selected'>[] {
	  let ret = this._messages?.filter(message => message.selected).map(({ role, content }) => ({
		role, content
	  })) || [];
	  return ret;
	}

	private _containsCodeBlockOrListItems(content: string): boolean {
		// Regex pattern to match code blocks.
		const codeBlockPattern = /```[\s\S]*?```/;
	
		// Regex pattern to match bullet points or numbered list items.
		const listItemPattern = /^(?:\s*(?:[-*+]|\d+\.)\s+.+)$/m;
	
		// Test if the content contains a code block or list items.
		return codeBlockPattern.test(content) || listItemPattern.test(content);
	}
	  

	private _updateChatMessages(promtNumberOfTokens:number, completionTokens:number) {
		let chat_response = "";
		if (this._messages) {
			this._messages.forEach((message, index) => {
				const selected = message.selected;
				const checked_string = selected ? "checked" : "";
				if (this._containsCodeBlockOrListItems(message.content)){
					chat_response += "\n# <u> <input id='message-checkbox-" + index + "' type='checkbox' " + checked_string + " onchange='myFunction(this)'> " + message.role.toUpperCase() + "</u>:\n" + message.content;
				} else {
					chat_response += "\n# <u> <input id='message-checkbox-" + index + "' type='checkbox' " + checked_string + " onchange='myFunction(this)'> " + message.role.toUpperCase() + "</u>: <div id='message-content-" + index + "' contenteditable='false' onclick='makeEditable(this)' onblur='saveContent(this)'>"+ message.content + "</div>";
				}
			});
		}
		if (this._totalNumberOfTokens !== undefined) {
			this._totalNumberOfTokens += promtNumberOfTokens + completionTokens;
			chat_response += `\n\n---\n*<sub>Total Tokens: ${this._totalNumberOfTokens},  Tokens used: ${promtNumberOfTokens + completionTokens} (${promtNumberOfTokens}+${completionTokens}), model: ${this._settings.model}, maxModelTokens: ${this._settings.maxModelTokens}, maxResponseTokens: ${this._settings.maxResponseTokens}</sub>* \n\n---\n\n\n\n\n\n\n`;
		}
		return chat_response;
	}
	
	private async _generate_search_prompt(prompt:string) {
		this._prompt = prompt;
		if (!prompt) {
			prompt = '';
		}

		// Focus the ChatGPT view
		if (!this._view) {
			await vscode.commands.executeCommand('chatgpt.chatView.focus');
		} else {
			this._view?.show?.(true);
		}

		// Initialize response and token count
		
		if (!this._response) {
			this._response = '';
		}
		if (!this._totalNumberOfTokens) {
			this._totalNumberOfTokens = 0;
		}

		// Get selected text and language ID (if applicable)
		const selection = vscode.window.activeTextEditor?.selection;
		const selectedText = vscode.window.activeTextEditor?.document.getText(selection);
		const languageId =
			(this._settings.codeblockWithLanguageId
				? vscode.window.activeTextEditor?.document?.languageId
				: undefined) || '';

		// Build the search prompt
		let searchPrompt = '';
		if (selection && selectedText) {
			if (this._settings.selectedInsideCodeblock) {
				searchPrompt = `${prompt}\n\`\`\`${languageId}\n${selectedText}\n\`\`\``;
			} else {
				searchPrompt = `${prompt}\n${selectedText}\n`;
			}
		} else {
			searchPrompt = prompt;
		}
		this._fullPrompt = searchPrompt;

		// Increment message number and store for tracking
		this._currentMessageNumber++;
		return searchPrompt;

	}

	public async search(prompt?: string) {
		// Check if the API key and URL are set
		if (!this._authInfo || !this._settings?.apiUrl) {
			this._view?.webview.postMessage({
				type: 'addResponse',
				value: '[ERROR] "API key or API URL not set, please go to extension settings (read README.md for more info)"',
			});
			return;
		}
		
		let chat_response = '';
		let searchPrompt = "";
		if (prompt!=undefined) {
			searchPrompt = await this._generate_search_prompt(prompt);
		} 
		// Show loading indicator
		this._view?.webview.postMessage({ type: 'setPrompt', value: this._prompt });
		this._view?.webview.postMessage({ type: 'addResponse', value: '...' });

		if (searchPrompt != "") {
			this._messages?.push({ role: "user", content: searchPrompt, selected:true })
		}

		if (!this._openai) {
		  throw new Error('OpenAI instance is not initialized.');
		}
		
		if (typeof this._settings.model !== 'string') {
		  throw new Error('Model identifier is not valid or not defined.');
		}

		// Only if you can't change the Message interface
		const isValidRole = (role: any): role is 'user' | 'assistant' | 'system' => {
		  return ['user', 'assistant', 'system'].includes(role);
		};
		
		// Validate and type narrow `this._messages` before sending
		if (!this._messages || !Array.isArray(this._messages) ||
			(!this._messages.every(msg => isValidRole(msg.role)))) {
		  throw new Error('Messages have invalid roles.');
		}

		const promtNumberOfTokens = this._getMessagesNumberOfTokens();
		try {
			console.log("Creating message sender...");
			const stream = await this._openai.chat.completions.create({
				model: this._settings.model,
				messages: this.getSelectedMessagesWithoutSelectedProperty(),
				stream: true,
				max_tokens: this._settings.maxResponseTokens,
			});
			console.log("Message sender created");
			
			let completionTokens = 0;
			let full_message = "";
			for await (const chunk of stream) {
				const content = chunk.choices[0]?.delta?.content || "";
				console.log("chunk:",chunk);
				console.log("content:", content);
				const tokenList = this._enc.encode(content);
				completionTokens += tokenList.length;
				console.log("tokens:", completionTokens);
				full_message += content;
				//this._response = chat_response;
				this._view?.webview.postMessage({ type: 'addResponse', value: full_message });

			}
			this._messages?.push({ role: "assistant", content: full_message, selected:true })
			console.log("Full message:", full_message);
			console.log("Full Number of tokens:", completionTokens);
			const tokenList = this._enc.encode(full_message);
			console.log("Full Number of tokens tiktoken:", tokenList.length);
			chat_response = this._updateChatMessages(promtNumberOfTokens, tokenList.length)
		} catch (e: any) {
			console.error(e);
			if (this._response!=undefined) {
				chat_response = this._response;
				chat_response += `\n\n---\n[ERROR] ${e}`;
			}
		}
		this._response = chat_response;
		this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
		this._view?.webview.postMessage({ type: 'setPrompt', value: '' });
	}

	private _getHtmlForWebview(webview: vscode.Webview) {

		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
		const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'styles.css'));
		const microlightUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'scripts', 'microlight.min.js'));
		const tailwindUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'scripts', 'showdown.min.js'));
		const showdownUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'scripts', 'tailwind.min.js'));

		
		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<script src="${tailwindUri}"></script>
			<script src="${showdownUri}"></script>
			<script src="${microlightUri}"></script>
			<link rel="stylesheet" href="${stylesUri}">
		</head>
		<body>
			<div id="container">
				<div id="top-wrapper">
					<input type="text" placeholder="Agent 1 Developer" />
					<select>
						<option value="option1">Agent 1 Developer</option>
						<option value="option2">Agent 2 Project Manajer</option>
						<!-- Additional options here -->
					</select>
					<button>+Add</button>
				</div>
				<div id="response" class="text-sm">
					<!-- response content goes here -->
				</div>
				<div id="input-wrapper">
					<!-- Model selector combobox -->
					<select id="model-selector">
						<option value="base-model">Base Model</option>
						<option value="advanced-model">Advanced Model</option>
						<!-- Add more models as necessary -->
					</select>
					<!-- Temperature slider and label -->
					<div>
						<label for="temperature-slider">Temperature:</label>
						<input type="range" id="temperature-slider" min="0" max="100" value="50" />
					</div>
					<!-- Text input for the prompt -->
					<input type="text" id="prompt-input" placeholder="Ask ChatGPT something">
				</div>
			</div>
        <script src="${scriptUri}"></script>
    	</body>
		</html>`;
	}
}


// This method is called when your extension is deactivated
export function deactivate() { }