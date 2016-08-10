"use strict";

module.exports = function(imports) {

    let express = imports.modules.express;
    let ObjectId = imports.modules.mongoose.Types.ObjectId;
    let Promise = imports.modules.Promise;
    let util = imports.util;

    let handler = util.handler;
    let requireLogin = util.requireLogin;
    let requireAdmin = util.requireAdmin;
    let hiddenGroups = util.hiddenGroups;
    let audienceQuery = hiddenGroups.audienceQuery;

    let User = imports.models.User;
    let Event = imports.models.Event;
    let AttendanceHandler = imports.models.AttendanceHandler;
    let Group = imports.models.Group;

    let router = express.Router();

    router.get("/events/startYear/:startYear/startMonth/:startMonth/endYear/:endYear/endMonth/:endMonth", requireLogin, handler(function*(req, res) {


        let startYear = req.params.startYear;
        let startMonth = req.params.startMonth;
        let endYear = parseInt(req.params.endYear);
        let endMonth = parseInt(req.params.endMonth);
        // does not work without parseInt...

        let start = new Date(startYear, startMonth, 1);
        let end = new Date(endYear, endMonth + 1, 1);

        let events = yield Event.find({
            $and: [{
                    date: {
                        $gte: start,
                        $lt: end,
                    }
                },
                audienceQuery(req.user),
            ]
        });

        res.json(events);

    }));

    router.get("/events/upcoming", requireLogin, handler(function*(req, res) {

        let events = yield Event.find({
            $and: [{
                    date: {
                        $gte: new Date(),
                    }
                },
                audienceQuery(req.user),
            ]
        }).sort("date");

        res.json(events);

    }));

    router.post("/events", requireAdmin, handler(function*(req, res) {

        req.body.hasAttendance = req.body.hasAttendance == "true";
        req.body.sendEmail = req.body.sendEmail == "true";
        console.log(req.body.date)

        let event = {
            name: req.body.name,
            date: new Date(req.body.date),
            audience: req.body.audience,
            creator: req.user._id,
            hasAttendance: req.body.hasAttendance,
        };

        if (req.body.description.length > 0) {
            event.description = req.body.description;
        }

        event = yield Event.create(event);

        let users = yield hiddenGroups.getUsersIn(event.audience);

        if (req.body.sendEmail) {

            let list = util.mail.createRecepientList(users);

            yield util.mail.sendEmail({
                to: list,
                subject: "New Event on " + util.readableDate(event.date) + " - " + event.name,
                html: req.user.firstname + " " + req.user.lastname + " has created an event on " + util.readableDate(event.date) + ",<br><br>" + event.name + "<br>" + req.body.description
            });

        }

        if (req.body.hasAttendance) {

            let attendees = users.map(attendee => ({
                user: attendee._id,
                status: "absent"
            }));

            yield AttendanceHandler.create({
                event: event._id,
                event_date: event.date,
                attendees: attendees
            });
        }

        res.json(event);

    }));

    router.delete("/events/id/:eventId", requireAdmin, handler(function*(req, res) {

        // TODO: check permissions

        yield Event.findOneAndRemove({
            _id: req.params.eventId
        });

        yield AttendanceHandler.findOneAndRemove({
            event: req.params.eventId
        });

        res.end("success");

    }));

    router.get("/events/id/:eventId/attendance", requireAdmin, handler(function*(req, res) {

        // TODO: check permissions

        let handler = yield AttendanceHandler.findOne({
            event: req.params.eventId
        }).populate("attendees.user");

        res.json(handler.attendees);

    }));

    router.put("/events/id/:eventId/attendance", requireAdmin, handler(function*(req, res) {

        // TODO: check permissions

        yield AttendanceHandler.update({
            event: req.params.eventId
        }, {
            "$set": {
                attendees: req.body.updatedAttendees
            }
        });

        res.end("success");

    }));

    // TODO: rename this route?
    router.put("/events/id/:eventId/users/:userId/excuseAbsence", requireAdmin, handler(function*(req, res) {

        // TODO: should permissions have to be checked here? I think not

        yield AttendanceHandler.update({
            event: req.params.eventId,
            "attendees.user": req.body.user_id
        }, {
            "$set": {
                "attendees.$.status": "excused"
            }
        });

        res.end("success");

    }));

    function getPresencesAbsences(attendanceHandlers, userId) {
        let absences = [];
        let present = 0;
        for (let handler of attendanceHandlers) {
            for (let attendee of handler.attendees) {
                if (attendee.user == userId) {
                    if (attendee.status == "absent") {
                        absences.push(handler.event);
                    } else if (attendee.status == "present") {
                        present++;
                    }
                    // do nothing if the absense is excused
                }
            }
        }
        return {
            present: present,
            absences: absences
        };
    }

    router.get("/users/id/:userId/absences", requireLogin, handler(function*(req, res) {

        let dateConstraints = {};
        if (req.query.startDate) {
            dateConstraints.$gte = new Date(req.query.startDate);
        }
        if (req.query.endDate) {
            dateConstraints.$lte = new Date(req.query.endDate);
        } else {
            dateConstraints.$lte = new Date();
        }

        let handlers = yield AttendanceHandler.find({
            event_date: dateConstraints,
            "attendees.user": req.params.userId
        }).populate("event").exec();

        let result = getPresencesAbsences(handlers, req.params.userId);

        res.json(result);

    }));

    return router;

};
