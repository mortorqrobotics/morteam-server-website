"use strict";

module.exports = function(imports) {

	let express = imports.modules.express;
	let Promise = imports.modules.Promise;
	let util = imports.util;

	let requireLogin = util.requireLogin;
	let requireLeader = util.requireLeader;

	let Task = schemas.Task;
	let User = schemas.User;

	let router = express.Router();

	router.post("/users/:userId/tasks", requireLogin, requireLeader, Promise.coroutine(function*(req, res) {

		// for iOS and Android
		if (typeof(req.body.due_date) == "string") {
			req.body.due_date = new Date(req.body.due_date);
		}

		let task = {
			name: req.body.task_name,
			team: req.user.current_team.id,
			for: req.params.userId, // why a reserved word :/
			due_date: req.body.due_date,
			creator: req.user._id,
			completed: false
		};

		if (req.body.task_description) {
			task.description = req.body.task_description; // TODO: rename to just description?
		}

		try {

			task = yield Task.create(task);

			let recipient = yield User.findById(task.for);

			if (!user) {
				return res.end("fail");
			}

			yield util.sendEmail({
				to: user.email,
				subject: "New Task Assigned By " + req.user.firstname + " " + req.user.lastname,
				text: "View your new task at http://www.morteam.com/u/" + task.for
			});

			res.end(task._id.toString());

		} catch (err) {
			console.error(err);
			res.end("fail");
		}
	}));

	router.get("/users/:userId/tasks/completed", requireLogin, Promise.coroutine(function*(req, res) {
		try {

			let tasks = yield Task.find({
				for: req.params.userId,
				completed: true
			}).populate("creator").exec();

			res.end(JSON.stringify(tasks));

		} catch (err) {
			console.error(err);
			res.end("fail");
		}
	}));

	// TODO: should completed and pending tasks be put into one request?

	router.get("/users/:userId/tasks/pending", requireLogin, Promise.coroutine(function*(req, res) {
		try {

			let tasks = yield Task.find({
				for: req.params.userId,
				completed: false
			}).populate("creator").exec();

			res.json(tasks);

		} catch (err) {
			console.error(err);
			res.end("fail");
		}
	}));

	router.post("/tasks/:taskId/markCompleted", requireLogin, Promise.coroutine(function*(req, res) {

		if (req.user._id != req.body.target_user // TODO: targetUserId instead?
				&& req.user.current_team.position != "admin"
				&& req.user.current_team.position != "leader" ) {

			return res.end("fail");

		}

		try {

			yield Task.findByIdAndUpdate(req.params.taskId, {
				"$set": { completed: true }
			});

			res.end("success");

		} catch (err) {
			console.error(err);
			res.end("fail");
		}
	}));

	return router;

};
