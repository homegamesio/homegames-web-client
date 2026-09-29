// Bind the shared game dispatcher to one local player. Browser input already
// emits the same message shape as the hosted WebSocket transport.
const GameDispatcher = require('homegames-common/game-dispatch');

class LocalDispatcher {
    constructor(game, playerId) {
        this.playerId = Number(playerId);
        this.dispatcher = new GameDispatcher(game);
        this.gameInput = this.dispatcher.gameInput;
    }

    handleMessage(msg) {
        let input;
        try { input = JSON.parse(msg); } catch (e) { return; }
        this.handleInput(input);
    }

    handleInput(input) { this.dispatcher.handleInput(this.playerId, input); }
    checkActivePresses() { this.dispatcher.checkActivePresses(this.playerId); }
    release() {
        this.gameInput.removePlayer(this.playerId);
        this.dispatcher.endPress(this.playerId, null);
    }
}

module.exports = LocalDispatcher;
