"use strict";
module.exports = function(imports) {

    let express = imports.modules.express;
    let ObjectId = imports.modules.mongoose.Types.ObjectId;
    let multer = imports.modules.multer;
    let extToMime = require("./extToMime.json");
    let Promise = imports.modules.Promise;
    let https = require("https");
    let util = imports.util;

    let handler = util.handler;
    let requireLogin = util.requireLogin;
    let checkBody = util.middlechecker.checkBody;
    let types = util.middlechecker.types;
    let audienceQuery = util.audience.audienceQuery;

    let Folder = imports.models.Folder;
    let File = imports.models.File;
    let Group = imports.models.Group;

    let router = express.Router();

    router.get("/files/id/:fileKey", checkBody(), requireLogin, handler(function*(req, res) {

        if (req.params.fileKey.indexOf("-preview") == -1) {

            let file = yield File.findOne({
                _id: req.params.fileKey,
            }).populate("folder");

            if (!file) {
                return res.status(404).end("File does not exist");
            }

            if (!util.audience.isUserInAudience(req.user, file.folder.audience)) {
                return res.status(403).end("You do not have permission to access this");
            }

        }

        yield util.s3.sendFile(res, req.params.fileKey);

    }));

    router.get("/folders", checkBody(), requireLogin, handler(function*(req, res) {

        let folders = yield Folder.find({
            $and: [{
                    parentFolder: {
                        $exists: false
                    }
                },
                audienceQuery(req.user),
            ]
        }).populate("audience.users audience.groups");

        res.json(folders);

    }));

    router.get("/folders/id/:folderId/subfolders", checkBody(), requireLogin, handler(function*(req, res) {

        let folders = yield Folder.find({
            $and: [{
                    parentFolder: req.params.folderId,
                },
                audienceQuery(req.user),
            ]
        });

        res.json(folders);

    }));

    router.get("/folders/id/:folderId/files", checkBody(), requireLogin, handler(function*(req, res) {

        let folder = yield Folder.findOne({
            _id: req.params.folderId,
        });

        if (!folder) {
            return res.status(404).end("That folder does not exist");
        }

        if (!util.audience.isUserInAudience(req.user, folder.audience)) {
            return res.status(403).end("You do not have permission to access this");
        }

        let files = yield File.find({
            folder: req.params.folderId,
        });

        res.json(files);

    }));

    router.post("/folders", checkBody({
        name: types.string,
        type: types.enum(["teamFolder"]), // TODO: no "subFolder" option, clean this up
        audience: types.audience,
    }), requireLogin, handler(function*(req, res) {

        if (req.body.name.length >= 22) {
            return res.status(400).end("Folder name must be less than 22 characters long");
            // TODO: get rid of this!
        }

        yield util.audience.ensureIncludes(req.body.audience, req.user);

        // what to do about this
        // if (req.body.type != "teamFolder" && req.body.type != "subFolder") {
        //     return res.status(400).end("Invalid folder type");
        // }
        // is this even still a thing

        let folder = {
            name: util.normalizeDisplayedText(req.body.name),
            audience: req.body.audience,
            creator: req.user._id,
            defaultFolder: false
        };

        // if (req.body.type == "teamFolder") {
            folder.parentFolder = undefined;
            folder.ancestors = [];
        // } else if (req.body.type == "subFolder") {
        //     folder.parentFolder = req.body.parentFolder;
        //     folder.ancestors = req.body.ancestors.concat([req.body.parentFolder]);
        // }

        folder = yield Folder.create(folder);

        res.json(folder);

    }))

    router.delete("/folders/id/:folderId", checkBody(), requireLogin, handler(function*(req, res) {

        let folder = yield Folder.findOne({
            _id: req.params.folderId
        });

        if (folder.defaultFolder) {
            return res.status(403).end("You cannot delete a default folder");
        }

        if (req.user._id.toString() != folder.creator.toString() &&
            !util.positions.isUserAdmin(req.user)
           ) {
            return res.status(403).end("You do not have permission to do this");
        }

        yield folder.remove();

        res.end();

    }));

    router.put("/folders/id/:folderId/name", checkBody({
        newName: types.string,
    }), requireLogin, handler(function*(req, res) {

        if (req.body.newName.length >= 20) {
            return res.status(400).end("Folder name has to be 19 characters or fewer");
        }

        let folder = yield Folder.findOne({
            $and: [
                { _id: req.params.folderId },
                audienceQuery(req.user),
            ],
        });

        if (!folder) {
            return res.status(404).end("This folder does not exist");
        }

        if (folder.defaultFolder) {
            return res.status(403).end("You cannot rename a default folder");
        }

        if (req.user._id.toString() != folder.creator.toString() &&
            !util.positions.isUserAdmin(req.user)
        ) {
            return res.status(403).end("You do not have permission");
        }

        folder.name = req.body.newName;

        yield folder.save();

        res.end();

    }));

    router.post("/files/upload", multer({
        limits: 50 * 1000000 // 50 megabytes
    }).single("uploadedFile"), checkBody({
        currentFolderId: types.objectId(Folder),
        fileName: types.string,
    }), requireLogin, handler(function*(req, res) {

        let folder = yield Folder.findOne({
            _id: req.body.currentFolderId,
        });

        if (!util.audience.isUserInAudience(req.user, folder.audience)) {
            return res.status(403).end("You cannot upload to this folder");
        }

        let ext = req.file.originalname.substring(req.file.originalname.lastIndexOf(".") + 1).toLowerCase() || "unknown";

        let mime = extToMime[ext];
        let disposition;

        if (mime == undefined) {
            disposition = "attachment; filename=" + req.file.originalname;
            mime = "application/octet-stream";
        } else {
            disposition = "attachment; filename=" + req.body.fileName + "." + ext;
        }

        req.body.fileName = util.normalizeDisplayedText(req.body.fileName);

        // TODO: check if the user has access to the folder

        let file = yield File.create({
            name: req.body.fileName,
            originalName: req.file.originalname,
            folder: req.body.currentFolderId,
            size: req.file.size,
            type: util.s3.extToType(ext),
            mimetype: mime,
            creator: req.user._id,
        });

        yield util.s3.uploadToDriveAsync(req.file.buffer, file._id, mime, disposition);

        if (file.type == "image") {
            let buffer = yield util.images.resizeImage(req.file.buffer, 280);
            yield util.s3.uploadToDriveAsync(buffer, file._id + "-preview", mime, disposition);
        }

        res.json(file);

    }));

    router.delete("/files/id/:fileId", checkBody(), requireLogin, handler(function*(req, res) {

        let file = yield File.findOne({
            _id: req.params.fileId
        }).populate("folder");

        if (req.user._id.toString() != file.creator.toString() &&
            !util.positions.isUserAdmin(req.user)) {
            return res.status(403).end("You do not have permission to do this");
        }

        yield util.s3.deleteFileFromDriveAsync(req.params.fileId);

        yield file.remove();

        if (file.type === "image") {
            yield util.s3.deleteFileFromDriveAsync(req.params.fileId + "-preview");
        }

        res.end();

    }));

    return router;

};
