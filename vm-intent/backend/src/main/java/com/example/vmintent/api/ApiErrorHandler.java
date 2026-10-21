package com.example.vmintent.api;

import com.example.vmintent.api.ApiModels.ApiError;
import io.temporal.client.WorkflowNotFoundException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/** Every error from /api comes back as the same JSON shape: {"error": "..."}. */
@RestControllerAdvice(basePackages = "com.example.vmintent.api")
public class ApiErrorHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiErrorHandler.class);

    @ExceptionHandler(WorkflowNotFoundException.class)
    public ResponseEntity<ApiError> notFound(WorkflowNotFoundException e) {
        String id = e.getExecution() == null ? null : e.getExecution().getWorkflowId();
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(new ApiError("No request or workflow with that ID", id, null));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MissingServletRequestParameterException.class,
            MethodArgumentTypeMismatchException.class})
    public ResponseEntity<ApiError> badRequest(Exception e) {
        String msg = e instanceof HttpMessageNotReadableException ? "Request body is not valid JSON for this endpoint"
                : e.getMessage();
        return ResponseEntity.badRequest().body(ApiError.of(msg));
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<ApiError> mediaType(HttpMediaTypeNotSupportedException e) {
        return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE)
                .body(ApiError.of("Send Content-Type: application/json"));
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<ApiError> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(ApiError.of(e.getReason()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> unexpected(Exception e) {
        log.error("Unexpected API error", e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(ApiError.of("Unexpected error: " + e.getClass().getSimpleName()));
    }
}
